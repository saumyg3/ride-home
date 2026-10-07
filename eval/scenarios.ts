// Named scenarios for the messy states Kai called out: auth, confirmation,
// and real-world state. Each one sets something up to go wrong, then checks
// what the integration *said* against what the simulated Uber says *happened*.

import type { BookResult, Confirmed, QuoteResult } from "../src/rides";
import type { Quote } from "../src/types";
import { harness, type Harness } from "../sim/harness";

export type Scenario = {
  id: string;
  group: "happy path" | "price & confirmation" | "double booking" | "network" | "ride state" | "auth" | "places";
  what: string;
  expect: string;
  run: (h: Harness) => Promise<string | true>;
};

const confirmOf = (q: Quote): Confirmed => ({ quote_id: q.id, price: q.priceDisplay, product: q.product.name, pickup: q.pickup.label, destination: q.destination.label });

async function quoteOk(h: Harness, destination = "home", product?: string): Promise<Quote> {
  const r: QuoteResult = await h.service.quote({ destination, product });
  if (r.kind !== "quote") throw new Error(`expected a quote, got ${r.kind}: ${"say" in r ? r.say : ""}`);
  return r.quote;
}

const rides = (h: Harness) => h.fake.created.length;
const fail = (msg: string, r?: unknown) => `${msg}${r ? ` (got ${JSON.stringify(r).slice(0, 160)})` : ""}`;

export const SCENARIOS: Scenario[] = [
  // ---------- happy path ----------
  {
    id: "happy",
    group: "happy path",
    what: "Quote, confirm, driver found, driver arriving",
    expect: "One ride at the quoted price; tracking reports the driver arriving with car and plate",
    run: async (h) => {
      const q = await quoteOk(h);
      const b = await h.service.book(confirmOf(q));
      if (b.kind !== "booked") return fail("not booked", b);
      if (h.fake.created[0]?.fareValue !== q.fare!.price.value) return fail("charged a different fare");
      h.fake.setStatus(b.ride.request_id, "accepted");
      h.clock.schedule(90_000, () => h.fake.setStatus(b.ride.request_id, "arriving"));
      const t = await h.service.track(20);
      if (t.kind !== "tracked" || t.ride.status !== "arriving" || !t.ride.vehicle?.license_plate) return fail("tracking didn't end on arriving", t);
      return rides(h) === 1 ? true : fail(`${rides(h)} rides`);
    },
  },

  // ---------- price & confirmation ----------
  {
    id: "fare-expired-same-price",
    group: "price & confirmation",
    what: "User takes 3 minutes to confirm; the 2-minute fare expires, price unchanged",
    expect: "Gets a fresh fare and books without asking again",
    run: async (h) => {
      const q = await quoteOk(h);
      h.clock.advance(180_000);
      const b = await h.service.book(confirmOf(q));
      if (b.kind !== "booked") return fail("not booked", b);
      return h.fake.created[0].fareValue === q.fare!.price.value ? true : fail("wrong fare");
    },
  },
  {
    id: "fare-expired-price-up-20",
    group: "price & confirmation",
    what: "Fare expires and the new price is 20% higher",
    expect: "Books nothing and asks again with the new price; booking the new quote then works",
    run: async (h) => {
      const q = await quoteOk(h);
      h.clock.advance(180_000);
      h.fake.priceFactor = 1.2;
      const b = await h.service.book(confirmOf(q));
      if (b.kind !== "price_changed") return fail("expected price_changed", b);
      if (rides(h) !== 0) return fail("booked anyway");
      const b2 = await h.service.book(confirmOf(b.quote));
      if (b2.kind !== "booked") return fail("re-approved quote didn't book", b2);
      return h.fake.created[0].fareValue === b.quote.fare!.price.value ? true : fail("charged a different fare than re-approved");
    },
  },
  {
    id: "fare-expired-price-up-2pct",
    group: "price & confirmation",
    what: "Fare expires and the new price is 2% higher (under the 3% and $1 limits)",
    expect: "Books, and says the fare refreshed to the new price",
    run: async (h) => {
      const q = await quoteOk(h);
      h.clock.advance(180_000);
      h.fake.priceFactor = 1.02;
      const b = await h.service.book(confirmOf(q));
      if (b.kind !== "booked") return fail("not booked", b);
      return b.repriced ? true : fail("didn't report the refreshed price");
    },
  },
  {
    id: "fare-expired-price-up-over-1",
    group: "price & confirmation",
    what: "Long Black ride: new price is 2.5% higher but that's over $1",
    expect: "Both limits must hold, so it asks again",
    run: async (h) => {
      const q = await quoteOk(h, "Los Angeles International Airport", "Black");
      h.clock.advance(180_000);
      h.fake.priceFactor = 1.025;
      const b = await h.service.book(confirmOf(q));
      if (b.kind !== "price_changed") return fail("expected price_changed", b);
      return rides(h) === 0 ? true : fail("booked anyway");
    },
  },
  {
    id: "fare-expired-price-down",
    group: "price & confirmation",
    what: "Fare expires and the new price is lower",
    expect: "Books at the lower price",
    run: async (h) => {
      const q = await quoteOk(h);
      h.clock.advance(180_000);
      h.fake.priceFactor = 0.9;
      const b = await h.service.book(confirmOf(q));
      return b.kind === "booked" && h.fake.created[0].fareValue! < q.fare!.price.value ? true : fail("expected a cheaper booking", b);
    },
  },
  {
    id: "fare-rejected-by-uber",
    group: "price & confirmation",
    what: "Fare looks valid locally but Uber says invalid_fare_id (clock skew)",
    expect: "Re-quotes once and books if within approval",
    run: async (h) => {
      const q = await quoteOk(h);
      h.fake.expiredFareCode = "invalid_fare_id";
      // Our clock says 105s old (outside the 10s safety margin, so we send it as is),
      // but Uber's clock is 20s ahead and already considers it expired.
      h.clock.advance(105_000);
      const realNow = h.clock.now;
      (h.fake as any).now = () => realNow() + 20_000;
      const b = await h.service.book(confirmOf(q));
      const posts = h.fake.calls.filter((c) => c.method === "POST" && c.path === "/v1.2/requests").length;
      if (posts !== 2) return fail(`expected Uber to reject the first fare, saw ${posts} booking calls`);
      return b.kind === "booked" && rides(h) === 1 ? true : fail("expected one booking", b);
    },
  },
  {
    id: "surge",
    group: "price & confirmation",
    what: "Surge pricing (1.8x) is on",
    expect: "Quote says so; booking stops for Uber's own accept step; after accepting, one ride",
    run: async (h) => {
      h.fake.setSurge("UberX", 1.8);
      const q = await quoteOk(h);
      if (!q.surge) return fail("quote didn't flag surge");
      const b = await h.service.book(confirmOf(q));
      if (b.kind !== "surge_acceptance" || !b.href) return fail("expected surge_acceptance with a link", b);
      if (rides(h) !== 0) return fail("booked before surge was accepted");
      h.fake.acceptSurge(b.quote.surge!.confirmationId!);
      const b2 = await h.service.book(confirmOf(b.quote));
      return b2.kind === "booked" && rides(h) === 1 ? true : fail("didn't book after acceptance", b2);
    },
  },
  {
    id: "surge-starts-mid-confirm",
    group: "price & confirmation",
    what: "Fixed price when quoted, surge starts before the fare refresh",
    expect: "Doesn't book; shows the surge price for approval",
    run: async (h) => {
      const q = await quoteOk(h);
      h.clock.advance(180_000);
      h.fake.setSurge("UberX", 2.1);
      const b = await h.service.book(confirmOf(q));
      return b.kind === "price_changed" && b.quote.surge && rides(h) === 0 ? true : fail("expected price_changed to surge", b);
    },
  },
  {
    id: "tampered-confirmation",
    group: "price & confirmation",
    what: "Agent passes a lower price than the quote to request_ride",
    expect: "Refused, nothing booked",
    run: async (h) => {
      const q = await quoteOk(h);
      const b = await h.service.book({ ...confirmOf(q), price: "$1.00" });
      return b.kind === "not_booked" && b.code === "confirmation_mismatch" && rides(h) === 0 ? true : fail("expected refusal", b);
    },
  },
  {
    id: "booked-before-user-answered",
    group: "price & confirmation",
    what: "Agent chains ride_quote straight into request_ride in one turn (seen in VoiceOS: the user said \"confirm\" about a cancel)",
    expect: "Nothing booked; it asks about that price. Booking works once the user has had time to answer",
    run: async () => {
      const h = harness({ config: { minConfirmGapMs: 6000 } });
      const q = await quoteOk(h, "John Wayne Airport");
      h.clock.advance(2000);
      const rushed = await h.service.book(confirmOf(q));
      if (rushed.kind !== "needs_answer" || rides(h) !== 0) return fail("expected needs_answer and no ride", rushed);
      h.clock.advance(5000);
      const b = await h.service.book(confirmOf(q));
      return b.kind === "booked" && rides(h) === 1 ? true : fail("expected a booking after the user answered", b);
    },
  },
  {
    id: "requoted-on-yes-turn",
    group: "price & confirmation",
    what: "User says yes, and the agent re-quotes the same ride before booking it",
    expect: "Books: the same ride type, places, and price count as already shown",
    run: async () => {
      const h = harness({ config: { minConfirmGapMs: 6000 } });
      await quoteOk(h);
      h.clock.advance(15_000);
      const again = await quoteOk(h);
      h.clock.advance(1000);
      const b = await h.service.book(confirmOf(again));
      return b.kind === "booked" && rides(h) === 1 ? true : fail("expected booking", b);
    },
  },
  {
    id: "wrong-destination-on-card",
    group: "price & confirmation",
    what: "Agent puts a different destination on the confirmation card than the quote",
    expect: "Refused, nothing booked",
    run: async (h) => {
      const q = await quoteOk(h);
      const b = await h.service.book({ ...confirmOf(q), destination: "John Wayne Airport" });
      return b.kind === "not_booked" && rides(h) === 0 ? true : fail("expected refusal", b);
    },
  },
  {
    id: "made-up-quote",
    group: "price & confirmation",
    what: "request_ride with a quote id that was never issued",
    expect: "Asks for a new quote, nothing booked",
    run: async (h) => {
      const b = await h.service.book({ quote_id: "q_invented", price: "$10.00", product: "UberX" });
      return b.kind === "not_booked" && b.code === "unknown_quote" && rides(h) === 0 ? true : fail("expected refusal", b);
    },
  },

  // ---------- double booking ----------
  {
    id: "confirm-twice",
    group: "double booking",
    what: "User confirms, then confirms the same quote again",
    expect: "Second confirm returns the same ride; still one ride",
    run: async (h) => {
      const q = await quoteOk(h);
      const a = await h.service.book(confirmOf(q));
      const b = await h.service.book(confirmOf(q));
      if (a.kind !== "booked" || b.kind !== "booked") return fail("expected both to report booked", [a.kind, b.kind]);
      return a.ride.request_id === b.ride.request_id && rides(h) === 1 ? true : fail(`${rides(h)} rides`);
    },
  },
  {
    id: "confirm-concurrently",
    group: "double booking",
    what: "Two confirmations arrive at the same moment",
    expect: "One ride; both report it",
    run: async (h) => {
      const q = await quoteOk(h);
      const [a, b] = await Promise.all([h.service.book(confirmOf(q)), h.service.book(confirmOf(q))]);
      if (a.kind !== "booked" || b.kind !== "booked") return fail("expected both booked", [a.kind, b.kind]);
      return rides(h) === 1 && a.ride.request_id === b.ride.request_id ? true : fail(`${rides(h)} rides`);
    },
  },
  {
    id: "second-quote-while-riding",
    group: "double booking",
    what: "User asks for another ride while one is on the way",
    expect: "Points to the existing ride instead of quoting",
    run: async (h) => {
      const q = await quoteOk(h);
      await h.service.book(confirmOf(q));
      const r = await h.service.quote({ destination: "John Wayne Airport" });
      return r.kind === "already_on_trip" && rides(h) === 1 ? true : fail("expected already_on_trip", r);
    },
  },
  {
    id: "old-quote-while-riding",
    group: "double booking",
    what: "Ride booked from quote A; user then confirms an older quote B",
    expect: "Doesn't book B; reports the active ride",
    run: async (h) => {
      const qa = await quoteOk(h);
      const qb = await quoteOk(h, "John Wayne Airport");
      await h.service.book(confirmOf(qa));
      const b = await h.service.book(confirmOf(qb));
      return b.kind === "already_on_trip" && rides(h) === 1 ? true : fail("expected already_on_trip", b);
    },
  },
  {
    id: "reuse-quote-after-ride-ended",
    group: "double booking",
    what: "Ride completed; agent re-sends the same old confirmation",
    expect: "Refuses to reuse the old quote",
    run: async (h) => {
      const q = await quoteOk(h);
      const a = await h.service.book(confirmOf(q));
      if (a.kind !== "booked") return fail("first booking failed", a);
      h.fake.setStatus(a.ride.request_id, "accepted");
      h.fake.setStatus(a.ride.request_id, "completed");
      const b = await h.service.book(confirmOf(q));
      return b.kind === "not_booked" && b.code === "quote_used" && rides(h) === 1 ? true : fail("expected quote_used", b);
    },
  },

  // ---------- network ----------
  {
    id: "lost-response-after-booking",
    group: "network",
    what: "Uber creates the ride but the response never arrives",
    expect: "Doesn't resend; finds the ride and reports it booked; one ride",
    run: async (h) => {
      const q = await quoteOk(h);
      h.fake.faults.push({ method: "POST", path: "/v1.2/requests", kind: "lost_response" });
      const b = await h.service.book(confirmOf(q));
      if (b.kind !== "booked" || !b.recoveredAfterTimeout) return fail("expected booked after recovery", b);
      return rides(h) === 1 ? true : fail(`${rides(h)} rides`);
    },
  },
  {
    id: "500-after-booking",
    group: "network",
    what: "Uber creates the ride, then returns a 500",
    expect: "Treats it as unknown, finds the ride, one ride",
    run: async (h) => {
      const q = await quoteOk(h);
      h.fake.faults.push({ method: "POST", path: "/v1.2/requests", kind: "500_after_commit" });
      const b = await h.service.book(confirmOf(q));
      return b.kind === "booked" && rides(h) === 1 ? true : fail("expected booked", b);
    },
  },
  {
    id: "connection-fails-before-uber",
    group: "network",
    what: "Connection drops before Uber gets the booking",
    expect: "Checks, finds no ride, says nothing was booked; doesn't retry on its own",
    run: async (h) => {
      const q = await quoteOk(h);
      h.fake.faults.push({ method: "POST", path: "/v1.2/requests", kind: "network" });
      const b = await h.service.book(confirmOf(q));
      if (b.kind !== "not_booked" || rides(h) !== 0) return fail("expected not_booked and no ride", b);
      const posts = h.fake.calls.filter((c) => c.method === "POST" && c.path === "/v1.2/requests").length;
      return posts === 1 ? true : fail(`sent the booking ${posts} times`);
    },
  },
  {
    id: "500-before-booking",
    group: "network",
    what: "Uber returns 500 without creating anything",
    expect: "Says nothing was booked; one booking attempt only",
    run: async (h) => {
      const q = await quoteOk(h);
      h.fake.faults.push({ method: "POST", path: "/v1.2/requests", kind: "500" });
      const b = await h.service.book(confirmOf(q));
      const posts = h.fake.calls.filter((c) => c.method === "POST" && c.path === "/v1.2/requests").length;
      return b.kind === "not_booked" && rides(h) === 0 && posts === 1 ? true : fail(`expected not_booked with 1 attempt, ${posts} attempts`, b);
    },
  },
  {
    id: "lost-response-and-uber-down",
    group: "network",
    what: "Booking response lost, and every follow-up check fails too",
    expect: "Says it can't tell, and to check the Uber app before trying again",
    run: async (h) => {
      const q = await quoteOk(h);
      h.fake.faults.push({ method: "POST", path: "/v1.2/requests", kind: "lost_response" });
      h.fake.faults.push({ method: "GET", path: "/v1.2/requests/current", kind: "network", times: 50 });
      const b = await h.service.book(confirmOf(q));
      return b.kind === "unknown" && /Uber app/.test(b.say) ? true : fail("expected unknown", b);
    },
  },
  {
    id: "flaky-reads",
    group: "network",
    what: "Price and ride-type lookups hit a 429 and a 503 first",
    expect: "Retries reads and quotes normally",
    run: async (h) => {
      h.fake.faults.push({ method: "GET", path: "/v1.2/products", kind: "429" });
      h.fake.faults.push({ method: "POST", path: "/v1.2/requests/estimate", kind: "500" });
      const q = await quoteOk(h);
      return q.fare ? true : fail("no quote");
    },
  },
  {
    id: "retry-request",
    group: "network",
    what: "Uber answers 409 retry_request to the booking",
    expect: "Checks no ride was created, retries once; one ride",
    run: async (h) => {
      const q = await quoteOk(h);
      h.fake.faults.push({ method: "POST", path: "/v1.2/requests", kind: "409_retry" });
      const b = await h.service.book(confirmOf(q));
      return b.kind === "booked" && rides(h) === 1 ? true : fail("expected one booking", b);
    },
  },
  {
    id: "rate-limited-booking",
    group: "network",
    what: "Booking gets a 429 rate limit",
    expect: "A 429 means Uber did nothing: says not booked, no blind retry",
    run: async (h) => {
      const q = await quoteOk(h);
      h.fake.faults.push({ method: "POST", path: "/v1.2/requests", kind: "429" });
      const b = await h.service.book(confirmOf(q));
      const posts = h.fake.calls.filter((c) => c.method === "POST" && c.path === "/v1.2/requests").length;
      return b.kind === "not_booked" && rides(h) === 0 && posts === 1 ? true : fail("expected a clean not_booked", b);
    },
  },

  // ---------- ride state ----------
  {
    id: "no-drivers",
    group: "ride state",
    what: "No drivers available",
    expect: "Status says no driver was found and nothing was booked",
    run: async (h) => {
      h.fake.driversAvailable = false;
      const q = await quoteOk(h);
      const b = await h.service.book(confirmOf(q));
      if (b.kind !== "booked") return fail("request wasn't accepted", b);
      const t = await h.service.track(5);
      return t.kind === "tracked" && t.ride.status === "no_drivers_available" ? true : fail("expected no_drivers_available", t);
    },
  },
  {
    id: "driver-cancels",
    group: "ride state",
    what: "Driver accepts, then cancels while the user is waiting",
    expect: "Tracking reports the cancellation; it doesn't silently rebook",
    run: async (h) => {
      const q = await quoteOk(h);
      const b = await h.service.book(confirmOf(q));
      if (b.kind !== "booked") return fail("not booked", b);
      h.fake.setStatus(b.ride.request_id, "accepted");
      h.clock.schedule(60_000, () => h.fake.setStatus(b.ride.request_id, "driver_canceled"));
      const t = await h.service.track(20);
      if (t.kind !== "tracked" || t.ride.status !== "driver_canceled") return fail("expected driver_canceled", t);
      return rides(h) === 1 ? true : fail("rebooked on its own");
    },
  },
  {
    id: "status-after-ride-gone",
    group: "ride state",
    what: "Driver canceled; the user later asks where their ride is",
    expect: "Explains the driver canceled, instead of 'no ride'",
    run: async (h) => {
      const q = await quoteOk(h);
      const b = await h.service.book(confirmOf(q));
      if (b.kind !== "booked") return fail("not booked", b);
      h.fake.setStatus(b.ride.request_id, "accepted");
      h.fake.setStatus(b.ride.request_id, "driver_canceled");
      const s = await h.service.status();
      return s.kind === "ride" && s.ride.status === "driver_canceled" ? true : fail("expected driver_canceled", s);
    },
  },
  {
    id: "track-timeout",
    group: "ride state",
    what: "Driver stuck at 'accepted' longer than the tracking window",
    expect: "Stops after the window and says so",
    run: async (h) => {
      const q = await quoteOk(h);
      const b = await h.service.book(confirmOf(q));
      if (b.kind !== "booked") return fail("not booked", b);
      h.fake.setStatus(b.ride.request_id, "accepted");
      const t = await h.service.track(2);
      return t.kind === "tracked" && t.timedOut ? true : fail("expected timedOut", t);
    },
  },
  {
    id: "cancel-current",
    group: "ride state",
    what: "User cancels while the driver is on the way",
    expect: "Cancels exactly that ride and confirms it",
    run: async (h) => {
      const q = await quoteOk(h);
      const b = await h.service.book(confirmOf(q));
      if (b.kind !== "booked") return fail("not booked", b);
      h.fake.setStatus(b.ride.request_id, "accepted");
      const c = await h.service.cancel(b.ride.request_id);
      return c.kind === "canceled" && h.fake.rideById(b.ride.request_id)?.status === "rider_canceled" ? true : fail("expected canceled", c);
    },
  },
  {
    id: "cancel-stale-id",
    group: "ride state",
    what: "Cancel is called with an old ride's id while a new ride is active",
    expect: "Refuses; the active ride is untouched",
    run: async (h) => {
      const q1 = await quoteOk(h);
      const a = await h.service.book(confirmOf(q1));
      if (a.kind !== "booked") return fail("not booked", a);
      h.fake.setStatus(a.ride.request_id, "accepted");
      h.fake.setStatus(a.ride.request_id, "driver_canceled");
      const q2 = await quoteOk(h);
      const b = await h.service.book(confirmOf(q2));
      if (b.kind !== "booked") return fail("second booking failed", b);
      const c = await h.service.cancel(a.ride.request_id);
      const active = h.fake.rideById(b.ride.request_id)?.status;
      return c.kind === "refused" && active === "processing" ? true : fail(`expected refusal, active ride is ${active}`, c);
    },
  },
  {
    id: "cancel-during-trip",
    group: "ride state",
    what: "User tries to cancel after the trip started",
    expect: "Refuses and explains",
    run: async (h) => {
      const q = await quoteOk(h);
      const b = await h.service.book(confirmOf(q));
      if (b.kind !== "booked") return fail("not booked", b);
      h.fake.setStatus(b.ride.request_id, "in_progress");
      const c = await h.service.cancel(b.ride.request_id);
      return c.kind === "refused" && c.code === "in_progress" ? true : fail("expected in_progress refusal", c);
    },
  },
  {
    id: "cancel-response-lost",
    group: "ride state",
    what: "Cancel goes through but the response is lost",
    expect: "Retries safely, then confirms the ride is canceled",
    run: async (h) => {
      const q = await quoteOk(h);
      const b = await h.service.book(confirmOf(q));
      if (b.kind !== "booked") return fail("not booked", b);
      h.fake.faults.push({ method: "DELETE", path: "/v1.2/requests/", kind: "lost_response" });
      const c = await h.service.cancel(b.ride.request_id);
      return c.kind === "canceled" ? true : fail("expected canceled", c);
    },
  },

  // ---------- auth ----------
  {
    id: "token-expired",
    group: "auth",
    what: "Uber rejects the access token mid-booking (401)",
    expect: "Renews the sign-in and books, once",
    run: async (h) => {
      const q = await quoteOk(h);
      h.fake.validTokens.clear();
      const b = await h.service.book(confirmOf(q));
      return b.kind === "booked" && h.tokens.refreshCalls === 1 && rides(h) === 1 ? true : fail("expected one refresh and one ride", b);
    },
  },
  {
    id: "signin-revoked",
    group: "auth",
    what: "Token rejected and the refresh token was revoked",
    expect: "Nothing booked; tells the user to run bun login",
    run: async (h) => {
      const q = await quoteOk(h);
      h.fake.validTokens.clear();
      h.tokens.canRefresh = false;
      const b = await h.service.book(confirmOf(q));
      return b.kind === "not_booked" && /bun login/.test(b.say) && rides(h) === 0 ? true : fail("expected a sign-in message", b);
    },
  },
  {
    id: "payment-declined",
    group: "auth",
    what: "Card has insufficient funds",
    expect: "Nothing booked; says to update payment in the Uber app",
    run: async (h) => {
      const q = await quoteOk(h);
      h.fake.paymentProblem = "insufficient_balance";
      const b = await h.service.book(confirmOf(q));
      return b.kind === "not_booked" && /Uber app/.test(b.say) && rides(h) === 0 ? true : fail("expected payment message", b);
    },
  },
  {
    id: "no-payment-method",
    group: "auth",
    what: "Account has no payment method",
    expect: "Nothing booked; says to add one in the Uber app",
    run: async (h) => {
      const q = await quoteOk(h);
      h.fake.paymentProblem = "missing_payment_method";
      const b = await h.service.book(confirmOf(q));
      return b.kind === "not_booked" && /payment method/.test(b.say) && rides(h) === 0 ? true : fail("expected payment message", b);
    },
  },

  // ---------- places ----------
  {
    id: "ambiguous-destination",
    group: "places",
    what: "\"Main Street\" matches streets in two cities",
    expect: "Asks which one; no quote",
    run: async (h) => {
      const r = await h.service.quote({ destination: "Main Street" });
      return r.kind === "ambiguous" && r.options.length === 2 ? true : fail("expected ambiguous", r);
    },
  },
  {
    id: "too-far",
    group: "places",
    what: "Destination is Las Vegas, over Uber's 100-mile limit",
    expect: "Explains why it can't quote",
    run: async (h) => {
      const r = await h.service.quote({ destination: "Las Vegas" });
      return r.kind === "problem" && /100 miles/.test(r.say) ? true : fail("expected 100-mile problem", r);
    },
  },
  {
    id: "same-place",
    group: "places",
    what: "Pickup and destination are both work",
    expect: "Says they're the same place",
    run: async (h) => {
      const r = await h.service.quote({ destination: "the office" });
      return r.kind === "problem" && r.code === "same_pickup_dropoff" ? true : fail("expected same_pickup_dropoff", r);
    },
  },
  {
    id: "map-down",
    group: "places",
    what: "Address lookup service fails",
    expect: "Clear message; suggests home or work",
    run: async (h) => {
      h.geocoder.failNext = 5;
      const r = await h.service.quote({ destination: "John Wayne Airport" });
      return r.kind === "problem" && r.code === "map_unavailable" ? true : fail("expected map_unavailable", r);
    },
  },
  {
    id: "ride-type-carried-over",
    group: "places",
    what: "Agent passes a ride type the user didn't ask for this time (\"Black\" carried over)",
    expect: "Quotes it, plus the default UberX price, so the user chooses; picking UberX books UberX",
    run: async (h) => {
      const r = await h.service.quote({ destination: "home", product: "Black" });
      if (r.kind !== "quote" || r.quote.product.name !== "Black" || r.alternative?.product.name !== "UberX") return fail("expected Black with an UberX alternative", r);
      const b = await h.service.book(confirmOf(r.alternative));
      if (b.kind !== "booked") return fail("UberX alternative didn't book", b);
      return h.fake.created[0].productId === r.alternative.product.id ? true : fail("booked the wrong ride type");
    },
  },
  {
    id: "unknown-product",
    group: "places",
    what: "User asks for a ride type that doesn't exist there (\"helicopter\")",
    expect: "Lists the ride types that are available",
    run: async (h) => {
      const r = await h.service.quote({ destination: "home", product: "helicopter" });
      return r.kind === "problem" && /UberX/.test(r.say) ? true : fail("expected product list", r);
    },
  },
];

export async function runScenarios() {
  const results = [];
  for (const s of SCENARIOS) {
    const h = harness({ seed: 11 });
    let outcome: string | true;
    try {
      outcome = await s.run(h);
    } catch (e) {
      outcome = `threw: ${(e as Error).message}`;
    }
    results.push({ ...s, pass: outcome === true, detail: outcome === true ? "" : outcome, ridesCreated: h.fake.created.length });
  }
  return results;
}
