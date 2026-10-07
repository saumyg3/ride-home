// Builds the RideService for the configured environment.
//   demo        simulated Uber + offline map, no account needed
//   sandbox     Uber's sandbox API (fake rides, real API)
//   production  real rides, real charges

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_PLACES, FakeGeocoder } from "../sim/fake-geocoder";
import { FakeUber } from "../sim/fake-uber";
import { configDir, FileTokenProvider, StaticTokenProvider } from "./auth";
import { NominatimGeocoder, PlaceResolver } from "./places";
import { MemoryStore, RideService, type LastRide, type RideConfig } from "./rides";
import type { Env } from "./types";
import { BASE_URL, UberClient, type TokenProvider } from "./uber";

/** Remembers the last ride across restarts (VoiceOS restarts the server on reload). */
class FileStore extends MemoryStore {
  private readonly path: string;
  constructor(env: string) {
    super();
    this.path = join(configDir(), `state-${env}.json`);
    try {
      const saved = JSON.parse(readFileSync(this.path, "utf8"));
      if (saved?.lastRide) super.setLastRide(saved.lastRide);
    } catch {
      /* first run */
    }
  }
  override setLastRide(r: LastRide) {
    super.setLastRide(r);
    try {
      if (!existsSync(configDir())) mkdirSync(configDir(), { recursive: true, mode: 0o700 });
      writeFileSync(this.path, JSON.stringify({ lastRide: r }), { mode: 0o600 });
    } catch (e) {
      console.error(`ride-home: couldn't save state: ${(e as Error).message}`);
    }
  }
}

export function envFrom(raw: string | undefined): Env {
  const v = (raw ?? "demo").trim().toLowerCase();
  return v === "sandbox" || v === "production" ? v : "demo";
}

export function configFromEnv(e: NodeJS.ProcessEnv): Partial<RideConfig> {
  return {
    ...(e.DEFAULT_PICKUP?.trim() ? { defaultPickup: e.DEFAULT_PICKUP.trim() } : {}),
    ...(e.DEFAULT_PRODUCT?.trim() ? { defaultProduct: e.DEFAULT_PRODUCT.trim() } : {}),
    ...(e.RIDE_CONFIRM_GAP_MS?.trim() ? { minConfirmGapMs: Number(e.RIDE_CONFIRM_GAP_MS) } : {}),
  };
}

export type Backend = { env: Env; service: RideService; fake?: FakeUber };

export function buildBackend(e: NodeJS.ProcessEnv = process.env): Backend {
  const env = envFrom(e.UBER_ENVIRONMENT);
  const config = { minConfirmGapMs: 6000, ...configFromEnv(e) };

  if (env === "demo") {
    const fake = new FakeUber({ progression: "timeline", places: DEMO_PLACES, seed: Date.now() % 1e6 });
    const uber = new UberClient({ baseUrl: "https://demo.invalid", tokens: new StaticTokenProvider("fake-token"), fetcher: fake.fetch });
    const places = new PlaceResolver(new FakeGeocoder(), (id) => uber.place(id));
    // Demo always picks up from "work" unless told otherwise, so "ride home" works out of the box.
    const service = new RideService({ uber, places, store: new MemoryStore(), config: { defaultPickup: "work", ...config } });
    return { env, service, fake };
  }

  const tokens: TokenProvider = e.UBER_ACCESS_TOKEN?.trim()
    ? new StaticTokenProvider(e.UBER_ACCESS_TOKEN.trim())
    : new FileTokenProvider(env, e.UBER_CLIENT_ID, e.UBER_CLIENT_SECRET);
  const uber = new UberClient({ baseUrl: BASE_URL[env], tokens });
  const places = new PlaceResolver(new NominatimGeocoder(), (id) => uber.place(id));
  const service = new RideService({ uber, places, store: new FileStore(env), config });
  return { env, service };
}
