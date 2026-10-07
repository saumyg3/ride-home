// Chaos run: hundreds of randomized sessions where a simulated user talks to
// the integration while the simulated Uber misbehaves (random faults on any
// call, surge, price drift, slow users, drivers canceling, double taps).
//
// After every step the hard rules are checked against ground truth:
//
//   R1  One approval, at most one ride. No approval (or double-tap of the same
//       approval) creates more than one real ride. A request that Uber ends
//       immediately with "no drivers available" never picks anyone up and
//       isn't charged, so it's counted separately as a dead request.
//   R2  Never above the approved price. Every fixed-price ride is charged at
//       most the approved fare plus the stated tolerance (3% and $1).
//   R3  What it says is what happened. "booked" means a ride with that id
//       exists; "not booked" / "price changed" / "surge" / "already riding"
//       means this call created no ride.
//   R4  Cancel only touches the named ride.
//   R5  It never throws. Every failure becomes a sentence for the user.

import type { BookResult, Confirmed } from "../src/rides";
import { withinApproval } from "../src/rides";
import type { Quote, RideStatus } from "../src/types";
import { ACTIVE } from "../src/types";
import type { FaultKind } from "../sim/fake-uber";
import { harness, type Harness } from "../sim/harness";

const DESTINATIONS = ["home", "John Wayne Airport", "UC Irvine", "Irvine Spectrum Center", "Disneyland", "Main Street", "Las Vegas", "work"];
const FAULTS: FaultKind[] = ["network", "lost_response", "500", "500_after_commit", "429", "409_retry"];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type ChaosReport = {
  sessions: number;
  steps: number;
  uberCalls: number;
  faultsInjected: Record<string, number>;
  outcomes: Record<string, number>;
  ridesBooked: number;
  violations: { rule: string; session: number; detail: string }[];
  unknownOutcomes: number;
  bookAttempts: number;
  /** Requests Uber created then ended with no drivers, during a lost response. */
  deadRequests: number;
};

const confirmOf = (q: Quote): Confirmed => ({ quote_id: q.id, price: q.priceDisplay, product: q.product.name, pickup: q.pickup.label, destination: q.destination.label });

export async function runChaos(sessions = 500, faultRate = 0.12): Promise<ChaosReport> {
  const rep: ChaosReport = { sessions, steps: 0, uberCalls: 0, faultsInjected: {}, outcomes: {}, ridesBooked: 0, violations: [], unknownOutcomes: 0, bookAttempts: 0, deadRequests: 0 };
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

  for (let s = 0; s < sessions; s++) {
    const r = rng(s * 7919 + 1);
    const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    const h: Harness = harness({ seed: s + 1 });
    const violate = (rule: string, detail: string) => rep.violations.push({ rule, session: s, detail });

    // The world for this session.
    if (r() < 0.15) h.fake.setSurge(pick(["UberX", "Comfort"]), Math.round((1.2 + r() * 1.3) * 10) / 10);
    if (r() < 0.1) h.fake.driversAvailable = false;
    if (r() < 0.05) h.fake.paymentProblem = pick(["missing_payment_method", "insufficient_balance"] as const);
    if (r() < 0.5) h.fake.expiredFareCode = "invalid_fare_id";
    if (r() < 0.05) h.tokens.canRefresh = false;
    h.fake.chaos = (method) => {
      if (r() >= faultRate) return undefined;
      // retry_request only makes sense on the booking call
      const kind = pick(method === "POST" ? FAULTS : FAULTS.filter((f) => f !== "409_retry"));
      bump(rep.faultsInjected, kind);
      return kind;
    };

    /** Approved price per ride, for R2. */
    const approvedFor = new Map<string, number>();
    let lastQuote: Quote | undefined;
    let lastRideId: string | undefined;

    const isDead = (id: string) => h.fake.rideById(id)?.status === "no_drivers_available";

    /** Checks one confirmation, or a double-tap pair, against what Uber actually created. */
    const checkBook = (results: BookResult[], before: number, approved: Quote) => {
      const created = h.fake.created.slice(before);
      const real = created.filter((c) => !isDead(c.requestId));
      const booked = results.filter((b): b is Extract<BookResult, { kind: "booked" }> => b.kind === "booked");
      for (const b of results) {
        bump(rep.outcomes, `book:${b.kind}`);
        if (b.kind === "unknown") rep.unknownOutcomes++;
      }
      if (real.length > 1) violate("R1", `one approval created ${real.length} real rides`);
      if (new Set(booked.map((b) => b.ride.request_id)).size > 1) violate("R1", "one approval reported two different rides");
      for (const b of booked) {
        if (!h.fake.rideById(b.ride.request_id)) violate("R3", "said booked, but no such ride exists");
        if (approved.fare) approvedFor.set(b.ride.request_id, approved.fare.price.value);
        lastRideId = b.ride.request_id;
      }
      // Said nothing was booked, but a real ride exists from this approval.
      const reportedIds = new Set(booked.map((b) => b.ride.request_id));
      const anyUnknown = results.some((b) => b.kind === "unknown");
      for (const c of real) if (!reportedIds.has(c.requestId) && !anyUnknown) violate("R3", `said ${results.map((b) => b.kind).join("+")} but ride ${c.requestId.slice(0, 8)} was created`);
      for (const c of created) {
        rep.ridesBooked++;
        if (isDead(c.requestId) && !reportedIds.has(c.requestId)) rep.deadRequests++;
        const ok = approvedFor.get(c.requestId) ?? (approved.fare?.price.value as number | undefined);
        if (c.fareValue !== undefined && ok !== undefined && !withinApproval(ok, c.fareValue, h.service.config)) {
          violate("R2", `approved ${ok}, charged ${c.fareValue}`);
        }
        if (c.surgeMultiplier > 1 && !approved.surge) violate("R2", "surge ride booked on a fixed-price approval");
      }
    };

    const steps = 3 + Math.floor(r() * 8);
    for (let i = 0; i < steps; i++) {
      rep.steps++;
      const roll = r();
      try {
        if (roll < 0.3 || !lastQuote) {
          const q = await h.service.quote({ destination: pick(DESTINATIONS), product: r() < 0.2 ? pick(["Comfort", "UberXL", "Black"]) : undefined });
          bump(rep.outcomes, `quote:${q.kind}`);
          if (q.kind === "quote") lastQuote = q.quote;
        } else if (roll < 0.6) {
          // The user hesitates, prices drift, then they confirm (sometimes twice, sometimes double-tapping).
          if (r() < 0.5) h.clock.advance(Math.floor(r() * 200_000));
          if (r() < 0.3) h.fake.priceFactor *= 0.9 + r() * 0.25;
          const q = lastQuote;
          const before = h.fake.created.length;
          rep.bookAttempts++;
          if (r() < 0.15) {
            const pair = await Promise.all([h.service.book(confirmOf(q)), h.service.book(confirmOf(q))]);
            checkBook(pair, before, q);
          } else {
            const b = await h.service.book(confirmOf(q));
            checkBook([b], before, q);
            if (b.kind === "price_changed") lastQuote = b.quote; // the user will be asked about this one
            if (b.kind === "surge_acceptance" && r() < 0.6 && b.quote.surge?.confirmationId) {
              h.fake.acceptSurge(b.quote.surge.confirmationId);
              lastQuote = b.quote;
            }
          }
          // Uber's world moves on: a driver accepts, maybe cancels, maybe arrives.
          if (lastRideId && h.fake.rideById(lastRideId)?.status === "processing" && h.fake.driversAvailable) {
            const id = lastRideId;
            h.clock.schedule(5_000 + r() * 20_000, () => h.fake.rideById(id)?.status === "processing" && h.fake.setStatus(id, "accepted"));
            const end: RideStatus = r() < 0.15 ? "driver_canceled" : "arriving";
            h.clock.schedule(60_000 + r() * 240_000, () => h.fake.rideById(id)?.status === "accepted" && h.fake.setStatus(id, end));
          }
        } else if (roll < 0.75) {
          const st = await h.service.status();
          bump(rep.outcomes, `status:${st.kind}`);
          if (st.kind === "ride" && !h.fake.rideById(st.ride.request_id)) violate("R3", "status reported a ride that doesn't exist");
        } else if (roll < 0.85) {
          const t = await h.service.track(Math.floor(r() * 8));
          bump(rep.outcomes, `track:${t.kind}`);
        } else {
          // Cancel: usually the ride we know about, sometimes a stale or invented id.
          const target = r() < 0.75 && lastRideId ? lastRideId : pick(["not-a-ride", lastRideId ?? "nope"]);
          const snapshot = new Map(h.fake.activeRides().map((x) => [x.request_id, x.status]));
          const c = await h.service.cancel(target);
          bump(rep.outcomes, `cancel:${c.kind}`);
          for (const [id, status] of snapshot) {
            const now = h.fake.rideById(id)?.status;
            if (id !== target && now === "rider_canceled" && status !== "rider_canceled") violate("R4", "cancel touched a ride it wasn't asked to");
          }
          if (c.kind === "canceled" && h.fake.rideById(target)?.status !== "rider_canceled") violate("R3", "said canceled but the ride isn't");
        }
      } catch (e) {
        violate("R5", `threw: ${(e as Error).message}`);
      }
      if (h.fake.activeRides().length > 1) violate("R1", "two active rides at once");
    }
    rep.uberCalls += h.fake.calls.length;
  }
  return rep;
}
