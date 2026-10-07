// A simulated Uber Riders API v1.2, modeled on Uber's sandbox: the same
// endpoints, statuses, error codes and two-minute fare expiry, plus the
// sandbox's controls (surge, no drivers, status changes).
//
// It powers two things:
//   - demo mode, so anyone can try the integration without an Uber account
//   - the eval, which also injects faults real APIs produce: dropped
//     connections, responses lost after the ride was created, 5xx, 429.
//
// It also keeps ground truth (every ride actually created and at what price)
// so the eval can check what the integration *said* against what *happened*.

import type { LatLng, RideStatus, UberRide } from "../src/types";
import { ACTIVE } from "../src/types";
import { miles } from "../src/places";

export type FaultKind =
  | "network" // connection fails before Uber sees the request
  | "lost_response" // Uber does the work, the response never arrives
  | "500" // Uber errors without doing anything
  | "500_after_commit" // Uber does the work, then returns 500
  | "429" // rate limited
  | "409_retry"; // Uber asks the client to retry, nothing created

export type Fault = { method: string; path: string; kind: FaultKind; times?: number };

type Product = { id: string; name: string; base: number; perMile: number; perMin: number; capacity: number };

type Fare = { id: string; productId: string; value: number; expiresAt: number; used: boolean };

type Ride = UberRide & {
  createdAt: number;
  fareValue?: number;
  surgeMultiplier: number;
  statusChangedAt: number;
  /** Reads since creation, for the "advance on read" progression mode. */
  reads: number;
  noDrivers: boolean;
};

export type CreatedRide = { requestId: string; productId: string; fareValue?: number; surgeMultiplier: number; createdAt: number };

const PRODUCTS: Product[] = [
  { id: "a1111c8c-c720-46c3-8534-2fcdd730040d", name: "UberX", base: 3.0, perMile: 1.35, perMin: 0.3, capacity: 4 },
  { id: "b3a6c8d1-4e2f-4a9b-9c1d-7e8f9a0b1c2d", name: "Comfort", base: 4.0, perMile: 1.75, perMin: 0.38, capacity: 4 },
  { id: "c7d8e9f0-1a2b-4c3d-8e4f-5a6b7c8d9e0f", name: "UberXL", base: 5.0, perMile: 2.2, perMin: 0.45, capacity: 6 },
  { id: "d1e2f3a4-5b6c-4d7e-8f9a-0b1c2d3e4f5a", name: "Black", base: 9.0, perMile: 3.6, perMin: 0.65, capacity: 4 },
];

/** Demo timeline, in seconds after booking. */
const ARRIVING_UNTIL = 45 + 5 * 60;
const TRIP_ENDS = ARRIVING_UNTIL + 12 * 60;

const DRIVERS = [
  { name: "Maria", rating: 4.95, vehicle: { color: "Gray", make: "Toyota", model: "Prius", license_plate: "8KLM214" } },
  { name: "Daniel", rating: 4.9, vehicle: { color: "White", make: "Honda", model: "Accord", license_plate: "9ABX732" } },
  { name: "Priya", rating: 4.97, vehicle: { color: "Black", make: "Tesla", model: "Model 3", license_plate: "7TES331" } },
  { name: "James", rating: 4.88, vehicle: { color: "Blue", make: "Hyundai", model: "Ioniq", license_plate: "8HYU590" } },
];

export type FakeUberOptions = {
  now?: () => number;
  /** "manual": status only changes via sandbox calls or advance(). "timeline": changes with time, for demo mode. */
  progression?: "manual" | "timeline";
  places?: Partial<Record<"home" | "work", { address: string; coords: LatLng }>>;
  seed?: number;
};

export class FakeUber {
  readonly products = PRODUCTS;
  surge = new Map<string, number>();
  driversAvailable = true;
  /** Every estimate after this is multiplied by it (sticky), e.g. 1.2 for "prices went up 20%". */
  priceFactor = 1;
  /** The error code returned for an expired fare: Uber documents both. */
  expiredFareCode: "fare_expired" | "invalid_fare_id" = "fare_expired";
  paymentProblem: null | "missing_payment_method" | "insufficient_balance" = null;
  validTokens = new Set(["fake-token"]);
  faults: Fault[] = [];
  /** Random faults for the chaos run, consulted when no scripted fault matches. */
  chaos?: (method: string, path: string) => FaultKind | undefined;

  /** Ground truth. */
  readonly created: CreatedRide[] = [];
  readonly calls: { method: string; path: string; status: number | "network" }[] = [];

  private fares = new Map<string, Fare>();
  private rides = new Map<string, Ride>();
  private surgeConfirmations = new Map<string, { productId: string; accepted: boolean }>();
  private readonly now: () => number;
  private readonly progression: "manual" | "timeline";
  private readonly placesSaved: NonNullable<FakeUberOptions["places"]>;
  private rand: () => number;
  private seq = 0;

  constructor(opts: FakeUberOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.progression = opts.progression ?? "manual";
    this.placesSaved = opts.places ?? {};
    let s = opts.seed ?? 42;
    this.rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  }

  // ---------- test & sandbox controls ----------

  setSurge(productName: string, multiplier: number) {
    const p = PRODUCTS.find((x) => x.name === productName)!;
    this.surge.set(p.id, multiplier);
  }

  /** The rider tapping "accept" on Uber's surge page. */
  acceptSurge(confirmationId: string) {
    const c = this.surgeConfirmations.get(confirmationId);
    if (c) c.accepted = true;
  }

  /** Same as PUT /v1.2/sandbox/requests/{id}. */
  setStatus(requestId: string, status: RideStatus) {
    const r = this.rides.get(requestId);
    if (!r) throw new Error(`no ride ${requestId}`);
    this.applyStatus(r, status);
  }

  activeRides(): Ride[] {
    return [...this.rides.values()].filter((r) => ACTIVE.has(this.statusOf(r)));
  }

  rideById(id: string) {
    return this.rides.get(id);
  }

  // ---------- fetch ----------

  readonly fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const u = new URL(url);
    const path = u.pathname;

    const fault = this.takeFault(method, path);
    if (fault?.kind === "network") {
      this.calls.push({ method, path, status: "network" });
      throw new TypeError("fetch failed: connection reset");
    }
    if (fault?.kind === "500") return this.log(method, path, this.err(500, "internal_server_error", "Internal error"));
    if (fault?.kind === "429") return this.log(method, path, this.err(429, "rate_limited", "Too many requests"));
    if (fault?.kind === "409_retry") return this.log(method, path, this.err(409, "retry_request", "Retry request."));

    const token = String((init.headers as Record<string, string>)?.Authorization ?? "").replace(/^Bearer /, "");
    let res: Response;
    if (!this.validTokens.has(token)) {
      res = this.err(401, "unauthorized", "Invalid OAuth 2.0 credentials provided.");
    } else {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      res = this.route(method, path, u.searchParams, body);
    }

    if (fault?.kind === "lost_response") {
      this.calls.push({ method, path, status: "network" });
      throw new TypeError("fetch failed: socket hang up");
    }
    if (fault?.kind === "500_after_commit") return this.log(method, path, this.err(500, "internal_server_error", "Internal error"));
    return this.log(method, path, res);
  };

  private takeFault(method: string, path: string): Fault | undefined {
    const i = this.faults.findIndex((f) => f.method === method && path.startsWith(f.path));
    if (i < 0) {
      const kind = this.chaos?.(method, path);
      return kind ? { method, path, kind } : undefined;
    }
    const f = this.faults[i];
    if (f.times === undefined || f.times <= 1) this.faults.splice(i, 1);
    else f.times--;
    return f;
  }

  private log(method: string, path: string, res: Response) {
    this.calls.push({ method, path, status: res.status });
    return res;
  }

  private json(status: number, body: unknown) {
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  private err(status: number, code: string, title: string, meta?: unknown) {
    return this.json(status, { ...(meta ? { meta } : {}), errors: [{ status, code, title }] });
  }

  // ---------- routes ----------

  private route(method: string, path: string, q: URLSearchParams, body: any): Response {
    let m: RegExpMatchArray | null;
    if (method === "GET" && path === "/v1.2/products") {
      return this.json(200, {
        products: PRODUCTS.map((p) => ({ product_id: p.id, display_name: p.name, capacity: p.capacity, upfront_fare_enabled: true, shared: false })),
      });
    }
    if (method === "POST" && path === "/v1.2/requests/estimate") return this.estimate(body);
    if (method === "POST" && path === "/v1.2/requests") return this.request(body);
    if (method === "GET" && path === "/v1.2/requests/current") {
      const r = this.activeRides()[0];
      return r ? this.json(200, this.view(r)) : this.err(404, "no_current_trip", "User is not currently on a trip.");
    }
    if ((m = path.match(/^\/v1\.2\/requests\/([^/]+)$/))) {
      const r = this.rides.get(decodeURIComponent(m[1]));
      if (!r) return this.err(404, "not_found", "The requested resource was not found.");
      if (method === "GET") return this.json(200, this.view(r));
      if (method === "DELETE") {
        const st = this.statusOf(r);
        if (!ACTIVE.has(st)) return this.err(409, "trip_ended", "This trip has already ended.");
        if (st === "in_progress") return this.err(409, "trip_in_progress", "Trip is in progress.");
        this.applyStatus(r, "rider_canceled");
        return this.json(204, null);
      }
    }
    if (method === "GET" && (m = path.match(/^\/v1\.2\/places\/(home|work)$/))) {
      const p = this.placesSaved[m[1] as "home" | "work"];
      return p ? this.json(200, { address: p.address }) : this.err(404, "not_found", "Place not set.");
    }
    if (method === "PUT" && (m = path.match(/^\/v1\.2\/sandbox\/requests\/([^/]+)$/))) {
      this.setStatus(m[1], body.status);
      return this.json(204, null);
    }
    if (method === "PUT" && (m = path.match(/^\/v1\.2\/sandbox\/products\/([^/]+)$/))) {
      if (body.surge_multiplier !== undefined) this.surge.set(m[1], body.surge_multiplier);
      if (body.drivers_available !== undefined) this.driversAvailable = body.drivers_available;
      return this.json(204, null);
    }
    return this.err(404, "not_found", `No route ${method} ${path}`);
  }

  private coordsOf(body: any, side: "start" | "end"): LatLng | undefined {
    const lat = body?.[`${side}_latitude`];
    const lng = body?.[`${side}_longitude`];
    if (typeof lat === "number" && typeof lng === "number") return { lat, lng };
    const id = body?.[`${side}_place_id`] as "home" | "work" | undefined;
    return id ? this.placesSaved[id]?.coords : undefined;
  }

  private tripCheck(body: any): Response | { dist: number; product: Product } {
    const a = this.coordsOf(body, "start");
    const b = this.coordsOf(body, "end");
    if (!a || !b) return this.err(422, "validation_failed", "Start and end locations are required.");
    const product = PRODUCTS.find((p) => p.id === body.product_id);
    if (!product) return this.err(404, "not_found", "Invalid product_id.");
    const dist = miles(a, b) * 1.25; // road distance is longer than straight-line
    if (dist > 100) return this.err(422, "distance_exceeded", "Distance between start and end location exceeds 100 miles.");
    if (miles(a, b) < 0.05) return this.err(422, "same_pickup_dropoff", "Pickup and Dropoff can't be the same.");
    return { dist, product };
  }

  private estimate(body: any): Response {
    if (this.activeRides().length) return this.err(403, "current_trip_exists", "Trip estimates not allowed while the user is currently on a trip.");
    const t = this.tripCheck(body);
    if (t instanceof Response) return t;
    const { dist, product } = t;
    const minutes = Math.max(4, dist * 2.4);
    const surge = this.surge.get(product.id) ?? 1;
    const raw = (product.base + product.perMile * dist + product.perMin * minutes) * this.priceFactor;
    const value = Math.round(raw * surge * 100) / 100;
    const trip = { distance_unit: "mile", duration_estimate: Math.round(minutes * 60), distance_estimate: Math.round(dist * 100) / 100 };
    const pickup_estimate = 2 + Math.floor(this.rand() * 6);

    if (surge > 1) {
      const id = `sc_${++this.seq}`;
      this.surgeConfirmations.set(id, { productId: product.id, accepted: false });
      const low = Math.floor(value * 0.92);
      const high = Math.ceil(value * 1.12);
      return this.json(200, {
        estimate: {
          surge_confirmation_href: `https://api.uber.com/v1.2/surge-confirmations/${id}`,
          surge_confirmation_id: id,
          surge_multiplier: surge,
          low_estimate: low,
          high_estimate: high,
          display: `$${low}-${high}`,
          currency_code: "USD",
        },
        trip,
        pickup_estimate,
      });
    }
    const fareId = `fare_${++this.seq}_${Math.floor(this.rand() * 1e9).toString(16)}`;
    this.fares.set(fareId, { id: fareId, productId: product.id, value, expiresAt: this.now() + 120_000, used: false });
    return this.json(200, {
      fare: {
        value,
        fare_id: fareId,
        expires_at: Math.floor((this.now() + 120_000) / 1000),
        display: `$${value.toFixed(2)}`,
        currency_code: "USD",
      },
      trip,
      pickup_estimate,
    });
  }

  private request(body: any): Response {
    const t = this.tripCheck(body);
    if (t instanceof Response) return t;
    if (this.activeRides().length) return this.err(409, "current_trip_exists", "User is already currently on a trip.");
    if (this.paymentProblem === "missing_payment_method") return this.err(409, "missing_payment_method", "The rider must have at least one payment method on file.");
    if (this.paymentProblem === "insufficient_balance") return this.err(400, "insufficient_balance", "Insufficient balance on the card.");

    const surge = this.surge.get(t.product.id) ?? 1;
    let fareValue: number | undefined;
    if (surge > 1) {
      const c = body.surge_confirmation_id ? this.surgeConfirmations.get(body.surge_confirmation_id) : undefined;
      if (!c || !c.accepted || c.productId !== t.product.id) {
        const id = body.surge_confirmation_id && c ? body.surge_confirmation_id : `sc_${++this.seq}`;
        if (!c) this.surgeConfirmations.set(id, { productId: t.product.id, accepted: false });
        return this.err(409, "surge", "Surge pricing is currently in effect for this product.", {
          surge_confirmation: { href: `https://api.uber.com/v1.2/surge-confirmations/${id}`, surge_confirmation_id: id },
          surge_multiplier: surge,
        });
      }
    } else {
      const fare = this.fares.get(body.fare_id);
      if (!fare || fare.productId !== t.product.id || fare.used) return this.err(422, "invalid_fare_id", "Invalid fare_id.");
      if (fare.expiresAt <= this.now()) {
        return this.expiredFareCode === "fare_expired"
          ? this.err(409, "fare_expired", "Fare has expired. Request a new estimate.")
          : this.err(422, "invalid_fare_id", "Invalid fare_id.");
      }
      fare.used = true;
      fareValue = fare.value;
    }

    const id = crypto.randomUUID();
    const r: Ride = {
      request_id: id,
      product_id: t.product.id,
      status: "processing",
      surge_multiplier: surge > 1 ? surge : null,
      driver: null,
      vehicle: null,
      location: null,
      pickup: { latitude: body.start_latitude, longitude: body.start_longitude, eta: 5 },
      destination: { latitude: body.end_latitude, longitude: body.end_longitude },
      createdAt: this.now(),
      statusChangedAt: this.now(),
      fareValue,
      surgeMultiplier: surge,
      reads: 0,
      noDrivers: !this.driversAvailable,
    };
    this.rides.set(id, r);
    this.created.push({ requestId: id, productId: t.product.id, fareValue, surgeMultiplier: surge, createdAt: r.createdAt });
    return this.json(202, this.view(r));
  }

  // ---------- ride state ----------

  private applyStatus(r: Ride, status: RideStatus) {
    r.status = status;
    r.statusChangedAt = this.now();
    if ((status === "accepted" || status === "arriving" || status === "in_progress") && !r.driver) {
      const d = DRIVERS[Math.floor(this.rand() * DRIVERS.length)];
      r.driver = { name: d.name, rating: d.rating, phone_number: "+15555550100" };
      r.vehicle = { ...d.vehicle };
    }
    if (status === "accepted") r.pickup = { ...r.pickup, eta: 4 };
    if (status === "arriving") r.pickup = { ...r.pickup, eta: 1 };
    if (status === "in_progress") r.destination = { ...r.destination, eta: 12 };
  }

  /**
   * In demo mode rides move along on their own: driver found (5s), arriving (45s), on the trip, done.
   * The driver waits at the pickup for 5 minutes so "where's my driver" and "cancel my ride" can be tried
   * after the arrival alert, then the trip takes 12 minutes.
   */
  private statusOf(r: Ride): RideStatus {
    if (this.progression !== "timeline" || !ACTIVE.has(r.status)) return r.status;
    const age = (this.now() - r.createdAt) / 1000;
    const want: RideStatus =
      r.noDrivers ? (age > 6 ? "no_drivers_available" : "processing")
      : age < 5 ? "processing"
      : age < 45 ? "accepted"
      : age < ARRIVING_UNTIL ? "arriving"
      : age < TRIP_ENDS ? "in_progress"
      : "completed";
    if (want !== r.status) this.applyStatus(r, want);
    if (r.status === "accepted") r.pickup = { ...r.pickup, eta: Math.max(1, Math.ceil((45 - age) / 10)) };
    if (r.status === "in_progress") r.destination = { ...r.destination, eta: Math.max(1, Math.ceil((TRIP_ENDS - age) / 60)) };
    return r.status;
  }

  private view(r: Ride): UberRide {
    this.statusOf(r);
    // Manual mode: a ride with no drivers resolves on the first read after booking, like the sandbox.
    if (this.progression === "manual" && r.noDrivers && r.status === "processing" && r.reads++ > 0) this.applyStatus(r, "no_drivers_available");
    const { createdAt, fareValue, surgeMultiplier, statusChangedAt, reads, noDrivers, ...pub } = r;
    return structuredClone(pub);
  }
}
