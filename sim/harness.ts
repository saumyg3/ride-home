// Wires RideService to the simulated Uber with a controllable clock, for
// tests and the eval. Sleeping advances the fake clock instead of waiting,
// so a 10-minute ride tracks in milliseconds.

import { PlaceResolver } from "../src/places";
import { MemoryStore, RideService, type RideConfig } from "../src/rides";
import { UberClient, type TokenProvider } from "../src/uber";
import { AuthRequired } from "../src/uber";
import { DEMO_PLACES, FakeGeocoder } from "./fake-geocoder";
import { FakeUber } from "./fake-uber";

export class Clock {
  t = Date.parse("2026-10-06T17:00:00Z");
  private events: { at: number; fn: () => void }[] = [];
  now = () => this.t;
  /** Runs `fn` once simulated time passes `delayMs` from now (e.g. "driver arrives in 90s"). */
  schedule = (delayMs: number, fn: () => void) => void this.events.push({ at: this.t + delayMs, fn });
  advance = (ms: number) => {
    this.t += ms;
    const due = this.events.filter((e) => e.at <= this.t).sort((a, b) => a.at - b.at);
    this.events = this.events.filter((e) => e.at > this.t);
    for (const e of due) e.fn();
  };
  sleep = async (ms: number) => {
    this.advance(ms);
    await Promise.resolve();
  };
}

/** Token store with a refreshable token, so the eval can expire sign-ins. */
export class TestTokens implements TokenProvider {
  token = "fake-token";
  refreshCalls = 0;
  canRefresh = true;
  constructor(private readonly fake: FakeUber) {}
  async get() {
    return this.token;
  }
  async refresh() {
    this.refreshCalls++;
    if (!this.canRefresh) throw new AuthRequired("Your Uber sign-in expired. Run `bun login` in the ride-home folder to sign in again.");
    this.token = `fake-token-${this.refreshCalls}`;
    this.fake.validTokens.add(this.token);
    return this.token;
  }
}

export type Harness = { fake: FakeUber; service: RideService; clock: Clock; tokens: TestTokens; geocoder: FakeGeocoder };

export function harness(opts: { seed?: number; config?: Partial<RideConfig> } = {}): Harness {
  const clock = new Clock();
  const fake = new FakeUber({ now: clock.now, places: DEMO_PLACES, seed: opts.seed ?? 7 });
  const tokens = new TestTokens(fake);
  const uber = new UberClient({ baseUrl: "https://sandbox.test", tokens, fetcher: fake.fetch, sleep: clock.sleep });
  const geocoder = new FakeGeocoder();
  const places = new PlaceResolver(geocoder, (id) => uber.place(id));
  const service = new RideService({
    uber,
    places,
    store: new MemoryStore(),
    config: { defaultPickup: "work", ...opts.config },
    now: clock.now,
    sleep: clock.sleep,
  });
  return { fake, service, clock, tokens, geocoder };
}
