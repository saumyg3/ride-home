// Booking logic. Every rule here is about one promise to the user:
//
//   1. You never get a ride you didn't approve, at a price you didn't approve.
//   2. You never get two rides.
//   3. What it tells you happened is what actually happened.
//
// The MCP server and the eval both drive this class directly, so the eval
// measures the same code the agent runs.

import { isHere, MapUnavailable, miles, PlaceResolver, type Resolved } from "./places";
import type { Money, Place, Quote, UberProduct, UberRide } from "./types";
import { ACTIVE, TERMINAL } from "./types";
import { AmbiguousWrite, AuthRequired, UberClient, UberError, UberUnavailable } from "./uber";

// ---------- results ----------

/** Exactly what the confirmation card showed the user. */
export type Confirmed = { quote_id: string; price: string; product: string; pickup?: string; destination?: string };

export type Problem = { kind: "problem"; code: string; say: string };

export type QuoteResult =
  | {
      kind: "quote";
      quote: Quote;
      otherProducts: string[];
      /**
       * When a non-default ride type was asked for, the default's quote too.
       * Voice agents sometimes carry a ride type over from an earlier request,
       * so the user always hears the everyday option and picks.
       */
      alternative?: Quote;
    }
  | { kind: "ambiguous"; field: "pickup" | "destination"; query: string; options: Place[] }
  | { kind: "already_on_trip"; ride: UberRide }
  | Problem;

export type BookResult =
  | { kind: "booked"; ride: UberRide; quote: Quote; repriced?: { from: string; to: string }; recoveredAfterTimeout?: boolean }
  | { kind: "price_changed"; was: string; quote: Quote }
  | { kind: "surge_acceptance"; quote: Quote; href?: string }
  | { kind: "already_on_trip"; ride: UberRide }
  /** Booked too soon after the price was first shown for the user to have answered. Nothing booked; ask them. */
  | { kind: "needs_answer"; quote: Quote }
  | { kind: "not_booked"; code: string; say: string }
  /** Couldn't tell whether a ride was booked. The user is told to check before retrying. */
  | { kind: "unknown"; say: string; ride?: UberRide };

export type StatusResult = { kind: "ride"; ride: UberRide } | { kind: "none" } | Problem;

export type TrackResult =
  | { kind: "tracked"; ride: UberRide; events: string[]; timedOut: boolean }
  | { kind: "none" }
  | Problem;

export type CancelResult =
  | { kind: "canceled"; ride: UberRide }
  | { kind: "refused"; code: string; say: string; ride?: UberRide }
  | Problem;

// ---------- config & state ----------

export type RideConfig = {
  defaultPickup?: string;
  defaultProduct: string;
  /** A re-quoted fare can be booked without asking again only if it's within BOTH limits. */
  maxIncreasePct: number;
  maxIncreaseAbs: number;
  /** Treat a fare as expired this long before Uber does, so it can't lapse in flight. */
  fareSafetyMs: number;
  reconcileChecks: number;
  reconcileIntervalMs: number;
  trackPollMs: number;
  /** How long to remember the last ride for "what happened to my ride". */
  lastRideTtlMs: number;
  /**
   * A booking for an offer first shown less than this long ago is refused and turned into a question.
   * Hearing a price and saying yes takes a person several seconds; an agent chaining
   * ride_quote straight into request_ride in one turn takes one or two.
   */
  minConfirmGapMs: number;
};

export const DEFAULT_CONFIG: RideConfig = {
  defaultProduct: "UberX",
  maxIncreasePct: 0.03,
  maxIncreaseAbs: 1.0,
  fareSafetyMs: 10_000,
  reconcileChecks: 4,
  reconcileIntervalMs: 1500,
  trackPollMs: 4000,
  lastRideTtlMs: 3 * 60 * 60 * 1000,
  minConfirmGapMs: 0,
};

/** The same offer re-quoted still counts as already shown, for this long. */
const OFFER_MEMORY_MS = 5 * 60_000;
const offerKey = (q: Quote) => [q.product.name, q.pickup.label, q.destination.label, q.priceDisplay].join("|");

export type LastRide = { requestId: string; quoteId?: string; bookedAt: number };

export interface RideStore {
  getQuote(id: string): Quote | undefined;
  putQuote(q: Quote): void;
  getLastRide(): LastRide | undefined;
  setLastRide(r: LastRide): void;
}

export class MemoryStore implements RideStore {
  private quotes = new Map<string, Quote>();
  private last: LastRide | undefined;
  getQuote(id: string) {
    return this.quotes.get(id);
  }
  putQuote(q: Quote) {
    this.quotes.set(q.id, q);
  }
  getLastRide() {
    return this.last;
  }
  setLastRide(r: LastRide) {
    this.last = r;
  }
}

export type Deps = {
  uber: UberClient;
  places: PlaceResolver;
  store: RideStore;
  config?: Partial<RideConfig>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
};

// ---------- helpers ----------

export const normProduct = (s: string) => s.toLowerCase().replace(/uber|\s|-/g, "").replace(/^pool$/, "share");

export function pickProduct(products: UberProduct[], wanted: string): UberProduct | undefined {
  const w = normProduct(wanted);
  return (
    products.find((p) => normProduct(p.display_name) === w) ??
    products.find((p) => normProduct(p.display_name).includes(w) || w.includes(normProduct(p.display_name)))
  );
}

/** Can a re-quoted fare be booked on the original approval? Cheaper always can. */
export function withinApproval(approved: number, next: number, c: Pick<RideConfig, "maxIncreasePct" | "maxIncreaseAbs">): boolean {
  if (next <= approved) return true;
  const up = next - approved;
  return up <= c.maxIncreaseAbs + 1e-9 && up <= approved * c.maxIncreasePct + 1e-9;
}

const PROBLEM_TEXT: Record<string, string> = {
  distance_exceeded: "That trip is over 100 miles, which is longer than Uber allows.",
  same_pickup_dropoff: "The pickup and destination are the same place.",
  outside_service_area: "Uber doesn't serve that destination.",
  destination_required: "I need a destination.",
  no_product_found: "That ride type isn't available there.",
  not_found: "That ride type isn't available there.",
  missing_payment_method: "Your Uber account has no payment method. Add one in the Uber app, then ask me again.",
  invalid_payment: "Uber didn't accept your payment method. Update it in the Uber app.",
  invalid_payment_method: "Uber didn't accept your payment method. Update it in the Uber app.",
  insufficient_balance: "Your card was declined for insufficient funds. Update it in the Uber app.",
  payment_method_not_allowed: "That payment method isn't allowed for this ride. Change it in the Uber app.",
  outstanding_balance_update_billing: "You have an outstanding balance on Uber. Settle it in the Uber app first.",
  pay_balance: "You have an outstanding balance on Uber. Settle it in the Uber app first.",
  card_assoc_outstanding_balance: "Your card has an outstanding balance on Uber. Settle it in the Uber app first.",
  unconfirmed_email: "Uber needs you to confirm your email first.",
  unverified: "Uber needs you to confirm your phone number first.",
  verification_required: "Uber needs you to finish a verification step in the Uber app.",
  too_many_cancellations: "Uber has paused ride requests on your account after too many cancellations.",
  product_not_allowed: "That ride type isn't available on your account.",
  forbidden: "Uber isn't allowing ride requests from your account right now.",
  user_not_allowed: "Uber isn't allowing ride requests from your account right now.",
  validation_failed: "Uber couldn't book that ride type to that destination.",
  invalid_seat_count: "That's more seats than this ride type allows.",
};

export function problemFrom(err: unknown): Problem {
  if (err instanceof AuthRequired) return { kind: "problem", code: "auth_required", say: err.message };
  if (err instanceof MapUnavailable) return { kind: "problem", code: "map_unavailable", say: "I couldn't look up that address just now. Try again, or say home or work." };
  if (err instanceof UberUnavailable) return { kind: "problem", code: "uber_unavailable", say: "I couldn't reach Uber just now. Try again in a moment." };
  if (err instanceof UberError) {
    return { kind: "problem", code: err.code, say: PROBLEM_TEXT[err.code] ?? `Uber said: ${err.message}` };
  }
  return { kind: "problem", code: "internal", say: `Something went wrong: ${(err as Error).message}` };
}

const money = (v: number, currency = "USD"): Money => ({ value: v, currency, display: `$${v.toFixed(2)}` });

// ---------- service ----------

export class RideService {
  readonly config: RideConfig;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newId: () => string;
  /** Booking and cancelling run one at a time, so two confirmations can't race. */
  private chain: Promise<unknown> = Promise.resolve();
  /** When each offer (ride type, pickup, destination, price) was first shown. */
  private offered = new Map<string, number>();

  constructor(private readonly d: Deps) {
    this.config = { ...DEFAULT_CONFIG, ...d.config };
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.newId = d.newId ?? (() => "q_" + crypto.randomUUID().replace(/-/g, "").slice(0, 10));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ----- quote -----

  async quote(args: { destination: string; pickup?: string; product?: string }): Promise<QuoteResult> {
    try {
      const pickupText = isHere(args.pickup) ? this.config.defaultPickup : args.pickup;
      if (!pickupText) {
        return {
          kind: "problem",
          code: "no_pickup",
          say: "Where should the driver pick you up? You can also set a default pickup in this integration's settings.",
        };
      }
      const pickupR = await this.d.places.resolve(pickupText);
      if (pickupR.kind !== "ok") return this.placeIssue(pickupR, "pickup");
      const destR = await this.d.places.resolve(args.destination, pickupR.place.coords);
      if (destR.kind !== "ok") return this.placeIssue(destR, "destination");
      const pickup = pickupR.place;
      const destination = destR.place;

      const same =
        (pickup.placeId && pickup.placeId === destination.placeId) ||
        (pickup.coords && destination.coords && miles(pickup.coords, destination.coords) < 0.05);
      if (same) return { kind: "problem", code: "same_pickup_dropoff", say: PROBLEM_TEXT.same_pickup_dropoff };

      if (!pickup.coords) {
        return { kind: "problem", code: "pickup_unmapped", say: `I couldn't place "${pickup.label}" on the map. Tell me the pickup address.` };
      }
      const { products } = await this.d.uber.products(pickup.coords.lat, pickup.coords.lng);
      if (!products?.length) return { kind: "problem", code: "no_products", say: "Uber has no rides available at that pickup right now." };

      const wanted = args.product || this.config.defaultProduct;
      const product = pickProduct(products, wanted) ?? (args.product ? undefined : products[0]);
      const otherProducts = products.map((p) => p.display_name).filter((n) => n !== product?.display_name);
      if (!product) {
        return {
          kind: "problem",
          code: "product_unavailable",
          say: `${wanted} isn't available there. Options are ${products.map((p) => p.display_name).join(", ")}.`,
        };
      }

      const quote = await this.estimate(product, pickup, destination);
      if (quote.kind !== "quote") return quote;
      let alternative: Quote | undefined;
      const fallback = pickProduct(products, this.config.defaultProduct);
      if (args.product && fallback && fallback.product_id !== product.product_id) {
        // Best effort: if this extra estimate fails, the requested quote still stands.
        const alt = await this.estimate(fallback, pickup, destination).catch(() => undefined);
        if (alt?.kind === "quote") alternative = alt.quote;
      }
      return { kind: "quote", quote: quote.quote, otherProducts, ...(alternative ? { alternative } : {}) };
    } catch (err) {
      if (err instanceof UberError && err.code === "current_trip_exists") {
        const ride = await this.d.uber.current().catch(() => null);
        if (ride) return { kind: "already_on_trip", ride };
      }
      return problemFrom(err);
    }
  }

  private placeIssue(r: Exclude<Resolved, { kind: "ok" }>, field: "pickup" | "destination"): QuoteResult {
    if (r.kind === "ambiguous") return { kind: "ambiguous", field, query: r.query, options: r.options };
    return { kind: "problem", code: `${field}_not_found`, say: r.message };
  }

  private locationBody(pickup: Place, destination: Place): Record<string, unknown> {
    const b: Record<string, unknown> = {};
    if (pickup.coords) Object.assign(b, { start_latitude: pickup.coords.lat, start_longitude: pickup.coords.lng });
    if (pickup.placeId) b.start_place_id = pickup.placeId;
    if (destination.coords) Object.assign(b, { end_latitude: destination.coords.lat, end_longitude: destination.coords.lng });
    if (destination.placeId) b.end_place_id = destination.placeId;
    return b;
  }

  /** One estimate call. Builds a new quote (new id) every time. */
  private async estimate(product: { product_id: string; display_name: string }, pickup: Place, destination: Place): Promise<{ kind: "quote"; quote: Quote } | Problem> {
    const res = await this.d.uber.estimate({ product_id: product.product_id, ...this.locationBody(pickup, destination) });
    const base = {
      id: this.newId(),
      createdAt: this.now(),
      product: { id: product.product_id, name: product.display_name },
      pickup,
      destination,
      pickupEtaMin: res?.pickup_estimate ?? undefined,
      tripMinutes: res?.trip?.duration_estimate ? Math.round(res.trip.duration_estimate / 60) : undefined,
      distanceMiles: res?.trip?.distance_estimate ?? undefined,
    };
    let quote: Quote;
    if (res?.fare?.fare_id) {
      const f = res.fare;
      const price: Money = { value: Number(f.value), currency: f.currency_code ?? "USD", display: f.display ?? money(Number(f.value)).display };
      // Uber gives expires_at in seconds.
      quote = { ...base, fare: { id: f.fare_id, expiresAt: Number(f.expires_at) * 1000, price }, priceDisplay: price.display };
    } else if (res?.estimate) {
      const e = res.estimate;
      const multiplier = Number(e.surge_multiplier ?? 1);
      const display = e.display ?? (e.low_estimate !== undefined ? `$${e.low_estimate}-${e.high_estimate}` : "price varies");
      quote = {
        ...base,
        surge: { multiplier, display, confirmationId: e.surge_confirmation_id, href: e.surge_confirmation_href },
        priceDisplay: multiplier > 1 ? `${display} (${multiplier}x surge)` : display,
      };
    } else {
      return { kind: "problem", code: "no_price", say: "Uber didn't return a price for that trip." };
    }
    this.d.store.putQuote(quote);
    const key = offerKey(quote);
    const first = this.offered.get(key);
    if (first === undefined || this.now() - first > OFFER_MEMORY_MS) this.offered.set(key, this.now());
    return { kind: "quote", quote };
  }

  // ----- book -----

  /**
   * Books the quote the user just approved. `confirmed` is what the
   * confirmation card showed, so the price and ride type must match the
   * stored quote exactly. Anything else is refused.
   */
  book(confirmed: Confirmed): Promise<BookResult> {
    return this.serial(() => this.bookInner(confirmed));
  }

  private async bookInner(confirmed: Confirmed): Promise<BookResult> {
    const quote = this.d.store.getQuote(confirmed.quote_id);
    if (!quote) {
      return { kind: "not_booked", code: "unknown_quote", say: "I don't have that price anymore. Ask me for a new quote first." };
    }
    const mismatch =
      confirmed.price !== quote.priceDisplay ||
      confirmed.product !== quote.product.name ||
      (confirmed.pickup !== undefined && confirmed.pickup !== quote.pickup.label) ||
      (confirmed.destination !== undefined && confirmed.destination !== quote.destination.label);
    if (mismatch) {
      return {
        kind: "not_booked",
        code: "confirmation_mismatch",
        say: `What you approved (${confirmed.product} at ${confirmed.price}) doesn't match the quote (${quote.product.name} from ${quote.pickup.label} to ${quote.destination.label} at ${quote.priceDisplay}). Nothing was booked.`,
      };
    }

    if (this.config.minConfirmGapMs > 0 && !quote.usedByRequestId) {
      const shownAt = this.offered.get(offerKey(quote)) ?? quote.createdAt;
      if (this.now() - shownAt < this.config.minConfirmGapMs) return { kind: "needs_answer", quote };
    }

    try {
      // Re-confirming the same approval returns the same ride, never a second one.
      if (quote.usedByRequestId) {
        const ride = await this.d.uber.ride(quote.usedByRequestId);
        if (ACTIVE.has(ride.status)) return { kind: "booked", ride, quote };
        // That ride is over; this quote can't be reused.
        return { kind: "not_booked", code: "quote_used", say: "That price was already used for an earlier ride. Ask me for a new quote." };
      }

      // Is there already a ride? Uber also checks, but this way we can say which one.
      let preCheckClear = false;
      try {
        const current = await this.d.uber.current();
        if (current && ACTIVE.has(current.status)) return { kind: "already_on_trip", ride: current };
        preCheckClear = true;
      } catch (e) {
        if (e instanceof AuthRequired) throw e;
        // Couldn't check. Uber rejects a second ride with current_trip_exists, so it's still safe to try.
      }

      // `quote` stays exactly what the user approved. `fare` is the live fare we book with.
      let fare = quote.fare;
      let repriced: { from: string; to: string } | undefined;
      const reprice = (next: NonNullable<Quote["fare"]>) => {
        if (next.price.display !== quote.priceDisplay) repriced = { from: quote.priceDisplay, to: next.price.display };
        fare = next;
      };

      // Fare about to lapse: get a fresh one and only proceed if it's within what was approved.
      if (fare && fare.expiresAt - this.config.fareSafetyMs <= this.now()) {
        const r = await this.refresh(quote);
        if (r.kind !== "ok") return r.result;
        reprice(r.fare);
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        const body: Record<string, unknown> = { product_id: quote.product.id, ...this.locationBody(quote.pickup, quote.destination) };
        if (fare) body.fare_id = fare.id;
        if (quote.surge?.confirmationId) body.surge_confirmation_id = quote.surge.confirmationId;

        let ride: UberRide;
        try {
          ride = await this.d.uber.createRequest(body);
        } catch (err) {
          if (err instanceof AmbiguousWrite) return this.reconcile(quote, preCheckClear, repriced);
          if (!(err instanceof UberError)) throw err;

          if (err.code === "fare_expired" || err.code === "invalid_fare_id") {
            if (attempt > 0 || !quote.fare) break;
            const r = await this.refresh(quote);
            if (r.kind !== "ok") return r.result;
            reprice(r.fare);
            continue;
          }
          if (err.code === "surge") {
            const sc = err.body?.meta?.surge_confirmation;
            quote.surge = {
              ...(quote.surge ?? { multiplier: Number(err.body?.meta?.surge_multiplier ?? 1), display: quote.priceDisplay }),
              ...(sc ? { confirmationId: sc.surge_confirmation_id, href: sc.href } : {}),
            };
            this.d.store.putQuote(quote);
            return { kind: "surge_acceptance", quote, href: quote.surge.href };
          }
          if (err.code === "current_trip_exists") {
            const current = await this.d.uber.current().catch(() => null);
            if (current) return { kind: "already_on_trip", ride: current };
            return { kind: "not_booked", code: err.code, say: "Uber says you already have a ride in progress." };
          }
          if (err.code === "retry_request") {
            if (attempt > 0) break;
            await this.sleep(1000);
            // Did the first attempt go through after all?
            const current = await this.d.uber.current().catch(() => undefined);
            if (current && ACTIVE.has(current.status)) {
              if (preCheckClear) return this.recordBooked(current, quote, repriced, true);
              return { kind: "unknown", ride: current, say: "There's an active ride on your account, but I can't confirm it's the one I just requested. Check the Uber app." };
            }
            continue;
          }
          const p = problemFrom(err);
          return { kind: "not_booked", code: p.code, say: p.say };
        }
        return this.recordBooked(ride, quote, repriced, false);
      }
      return { kind: "not_booked", code: "retry_exhausted", say: "Uber wouldn't accept the request. Nothing was booked." };
    } catch (err) {
      const p = problemFrom(err);
      // Every path that reaches here failed before a ride could be created.
      return { kind: "not_booked", code: p.code, say: p.say };
    }
  }

  private recordBooked(ride: UberRide, quote: Quote, repriced: { from: string; to: string } | undefined, recovered: boolean): BookResult {
    // Marks the approved quote, so confirming it again returns this ride instead of booking another.
    quote.usedByRequestId = ride.request_id;
    this.d.store.putQuote(quote);
    this.d.store.setLastRide({ requestId: ride.request_id, quoteId: quote.id, bookedAt: this.now() });
    return { kind: "booked", ride, quote, repriced, ...(recovered ? { recoveredAfterTimeout: true } : {}) };
  }

  /**
   * New fare for the same trip. "ok" only if it can be booked on the existing
   * approval. Otherwise the new quote goes back to the user to approve.
   */
  private async refresh(q: Quote): Promise<{ kind: "ok"; fare: NonNullable<Quote["fare"]> } | { kind: "stop"; result: BookResult }> {
    const r = await this.estimate({ product_id: q.product.id, display_name: q.product.name }, q.pickup, q.destination);
    if (r.kind !== "quote") return { kind: "stop", result: { kind: "not_booked", code: r.code, say: r.say } };
    const next = r.quote;
    // Fixed price turned into surge, or the increase is past the limit: the user has to see it.
    if (next.surge || !q.fare || !next.fare || !withinApproval(q.fare.price.value, next.fare.price.value, this.config)) {
      return { kind: "stop", result: { kind: "price_changed", was: q.priceDisplay, quote: next } };
    }
    return { kind: "ok", fare: next.fare };
  }

  /**
   * The booking request got no clear answer. Look for the ride instead of
   * sending the request again, which is how double bookings happen.
   */
  private async reconcile(q: Quote, preCheckClear: boolean, repriced?: { from: string; to: string }): Promise<BookResult> {
    let checked = false;
    for (let i = 0; i < this.config.reconcileChecks; i++) {
      await this.sleep(this.config.reconcileIntervalMs);
      try {
        const current = await this.d.uber.current();
        checked = true;
        if (current && ACTIVE.has(current.status)) {
          if (preCheckClear) return this.recordBooked(current, q, repriced, true);
          return {
            kind: "unknown",
            ride: current,
            say: "Uber didn't confirm, and there's an active ride on your account that I can't tie to this request. Check the Uber app before booking again.",
          };
        }
      } catch (e) {
        if (e instanceof AuthRequired) break;
      }
    }
    if (checked) {
      return {
        kind: "not_booked",
        code: "no_response",
        say: "Uber didn't respond, and no ride shows up on your account, so nothing was booked. Want me to try again?",
      };
    }
    return {
      kind: "unknown",
      say: "Uber didn't respond and I couldn't check your account afterward. Check the Uber app before booking again so you don't end up with two rides.",
    };
  }

  // ----- status -----

  async status(): Promise<StatusResult> {
    try {
      const current = await this.d.uber.current();
      if (current) {
        const last = this.d.store.getLastRide();
        if (!last || last.requestId !== current.request_id) this.d.store.setLastRide({ requestId: current.request_id, bookedAt: this.now() });
        return { kind: "ride", ride: current };
      }
      // No active ride. If we booked one recently, say what happened to it.
      const last = this.d.store.getLastRide();
      if (last && this.now() - last.bookedAt < this.config.lastRideTtlMs) {
        const ride = await this.d.uber.ride(last.requestId);
        return { kind: "ride", ride };
      }
      return { kind: "none" };
    } catch (err) {
      return problemFrom(err);
    }
  }

  /** Polls until the driver is arriving, the trip starts, or the ride ends. */
  async track(maxMinutes: number): Promise<TrackResult> {
    const deadline = this.now() + maxMinutes * 60_000;
    const events: string[] = [];
    let lastStatus: string | undefined;
    let lastDriver: string | undefined;
    let errors = 0;
    for (;;) {
      const s = await this.status();
      if (s.kind === "problem") {
        // A blip during a 10-minute wait shouldn't end tracking.
        if (++errors >= 5) return s;
      } else {
        errors = 0;
        if (s.kind === "none") return { kind: "none" };
        const r = s.ride;
        if (r.status !== lastStatus) {
          events.push(r.status);
          lastStatus = r.status;
        }
        const driver = r.driver?.name;
        if (driver && lastDriver && driver !== lastDriver) events.push(`driver_changed:${driver}`);
        if (driver) lastDriver = driver;
        if (r.status === "arriving" || r.status === "in_progress" || TERMINAL.has(r.status)) {
          return { kind: "tracked", ride: r, events, timedOut: false };
        }
        if (this.now() >= deadline) return { kind: "tracked", ride: r, events, timedOut: true };
      }
      if (this.now() >= deadline) return { kind: "problem", code: "uber_unavailable", say: "I lost track of your ride. Ask me where your driver is." };
      await this.sleep(this.config.trackPollMs);
    }
  }

  // ----- cancel -----

  /** Cancels the named ride only, never "whatever ride is current". */
  cancel(requestId: string): Promise<CancelResult> {
    return this.serial(() => this.cancelInner(requestId));
  }

  private async cancelInner(requestId: string): Promise<CancelResult> {
    try {
      const current = await this.d.uber.current();
      if (!current || current.request_id !== requestId) {
        let named: UberRide | undefined;
        try {
          named = await this.d.uber.ride(requestId);
        } catch {
          /* unknown id */
        }
        if (named && TERMINAL.has(named.status)) {
          return { kind: "refused", code: `already_${named.status}`, ride: named, say: `That ride is already ${named.status.replace(/_/g, " ")}, so there's nothing to cancel.` };
        }
        return {
          kind: "refused",
          code: "not_current",
          ride: current ?? undefined,
          say: current ? "That isn't your current ride, so I didn't cancel anything. Ask me for your ride status first." : "You don't have an active ride to cancel.",
        };
      }
      if (current.status === "in_progress") {
        return { kind: "refused", code: "in_progress", ride: current, say: "You're already on the trip, so it can't be canceled." };
      }
      try {
        await this.d.uber.cancel(requestId);
      } catch (e) {
        if (!(e instanceof UberError) || (e.status !== 404 && e.status !== 409)) throw e;
        // Already gone. Check below what state it ended in.
      }
      const after = await this.d.uber.ride(requestId);
      if (after.status === "rider_canceled") return { kind: "canceled", ride: after };
      if (TERMINAL.has(after.status)) {
        return { kind: "refused", code: `already_${after.status}`, ride: after, say: `That ride ended as ${after.status.replace(/_/g, " ")} before I could cancel it.` };
      }
      return { kind: "problem", code: "cancel_unconfirmed", say: "I asked Uber to cancel, but the ride still shows as active. Check the Uber app." };
    } catch (err) {
      return problemFrom(err);
    }
  }
}
