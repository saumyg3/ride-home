import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTokenProvider, loadTokens, saveTokens, tokensFromResponse } from "../src/auth";
import { envFrom } from "../src/backend";
import { clean, miles, PlaceResolver, savedPlaceId } from "../src/places";
import { normProduct, pickProduct, withinApproval } from "../src/rides";
import { describeRide, plateSpoken } from "../src/speak";
import { AmbiguousWrite, AuthRequired, parseError, UberClient, UberError, UberUnavailable, type Fetcher } from "../src/uber";
import { FakeGeocoder } from "../sim/fake-geocoder";

const noSleep = async () => {};
const tokens = (t = "tok") => ({ get: async () => t, refresh: async () => "tok2" });

function scripted(responses: (Response | Error)[]) {
  const seen: { url: string; method: string; auth: string }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    seen.push({ url, method: init.method ?? "GET", auth: String((init.headers as any).Authorization) });
    const next = responses.shift();
    if (!next) throw new Error("no more scripted responses");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetcher, seen };
}
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

describe("Uber client retry rules", () => {
  test("retries reads on network errors and 5xx", async () => {
    const { fetcher, seen } = scripted([new TypeError("reset"), json(503), json(200, { products: [] })]);
    const c = new UberClient({ baseUrl: "https://x", tokens: tokens(), fetcher, sleep: noSleep });
    expect(await c.products(1, 2)).toEqual({ products: [] });
    expect(seen.length).toBe(3);
  });

  test("gives up on reads after the retry budget", async () => {
    const { fetcher } = scripted([json(500), json(500), json(500)]);
    const c = new UberClient({ baseUrl: "https://x", tokens: tokens(), fetcher, sleep: noSleep });
    expect(c.products(1, 2)).rejects.toBeInstanceOf(UberUnavailable);
  });

  test("never retries ride creation; a timeout is ambiguous", async () => {
    const { fetcher, seen } = scripted([new TypeError("timeout"), json(202, { request_id: "r" })]);
    const c = new UberClient({ baseUrl: "https://x", tokens: tokens(), fetcher, sleep: noSleep });
    expect(c.createRequest({})).rejects.toBeInstanceOf(AmbiguousWrite);
    await Bun.sleep(1);
    expect(seen.length).toBe(1);
  });

  test("a 5xx on ride creation is ambiguous, a 429 is a clean rejection", async () => {
    const a = new UberClient({ baseUrl: "https://x", tokens: tokens(), fetcher: scripted([json(502)]).fetcher, sleep: noSleep });
    expect(a.createRequest({})).rejects.toBeInstanceOf(AmbiguousWrite);
    const b = new UberClient({ baseUrl: "https://x", tokens: tokens(), fetcher: scripted([json(429, { code: "rate_limited", message: "slow down" })]).fetcher, sleep: noSleep });
    expect(b.createRequest({})).rejects.toBeInstanceOf(UberError);
  });

  test("a 401 refreshes the token once and retries, even for ride creation", async () => {
    const { fetcher, seen } = scripted([json(401), json(202, { request_id: "r", status: "processing" })]);
    const c = new UberClient({ baseUrl: "https://x", tokens: tokens("old"), fetcher, sleep: noSleep });
    const ride = await c.createRequest({});
    expect(ride.request_id).toBe("r");
    expect(seen.length).toBe(2);
  });

  test("a second 401 asks the user to sign in", async () => {
    const { fetcher } = scripted([json(401), json(401)]);
    const c = new UberClient({ baseUrl: "https://x", tokens: tokens(), fetcher, sleep: noSleep });
    expect(c.products(1, 2)).rejects.toBeInstanceOf(AuthRequired);
  });

  test("current() maps 404 to no ride", async () => {
    const c = new UberClient({ baseUrl: "https://x", tokens: tokens(), fetcher: scripted([json(404, { code: "no_current_trip" })]).fetcher, sleep: noSleep });
    expect(await c.current()).toBeNull();
  });

  test("parses both of Uber's error shapes", () => {
    expect(parseError(409, { errors: [{ status: 409, code: "surge", title: "Surge" }] }).code).toBe("surge");
    expect(parseError(422, { code: "invalid_fare_id", message: "bad" }).code).toBe("invalid_fare_id");
    expect(parseError(500, undefined).code).toBe("http_500");
  });
});

describe("sign-in tokens", () => {
  test("saved with owner-only permissions and read back", async () => {
    process.env.RIDE_HOME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "rh-test-"));
    await saveTokens("sandbox", { access_token: "a", refresh_token: "r", expires_at: 1 });
    expect((await loadTokens("sandbox"))?.access_token).toBe("a");
    const mode = statSync(join(process.env.RIDE_HOME_CONFIG_DIR, "tokens-sandbox.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("expired tokens are renewed with the refresh token, once for parallel callers", async () => {
    process.env.RIDE_HOME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "rh-test-"));
    await saveTokens("sandbox", { access_token: "old", refresh_token: "r1", expires_at: Date.now() - 1000 });
    let calls = 0;
    const fetcher: Fetcher = async (_u, init) => {
      calls++;
      expect(String(init.body)).toContain("grant_type=refresh_token");
      return json(200, { access_token: "new", expires_in: 2592000 });
    };
    const p = new FileTokenProvider("sandbox", "id", "secret", fetcher);
    const [a, b] = await Promise.all([p.get(), p.get()]);
    expect([a, b]).toEqual(["new", "new"]);
    expect(calls).toBe(1);
    expect((await loadTokens("sandbox"))?.refresh_token).toBe("r1"); // kept when Uber doesn't send a new one
  });

  test("a revoked refresh token gives a clear message", async () => {
    process.env.RIDE_HOME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "rh-test-"));
    await saveTokens("sandbox", { access_token: "old", refresh_token: "r1", expires_at: Date.now() - 1000 });
    const p = new FileTokenProvider("sandbox", "id", "secret", async () => json(400, { error: "invalid_grant" }));
    expect(p.get()).rejects.toThrow("bun login");
  });

  test("not signed in at all says how to sign in", async () => {
    process.env.RIDE_HOME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "rh-test-"));
    expect(new FileTokenProvider("production", "id", "secret").get()).rejects.toThrow("bun login");
  });

  test("token response without an access token is rejected", () => {
    expect(() => tokensFromResponse({})).toThrow();
    expect(tokensFromResponse({ access_token: "a", expires_in: 10 }, 0).expires_at).toBe(10_000);
  });
});

describe("price approval", () => {
  const c = { maxIncreasePct: 0.03, maxIncreaseAbs: 1 };
  test("cheaper or equal always ok", () => {
    expect(withinApproval(20, 18, c)).toBe(true);
    expect(withinApproval(20, 20, c)).toBe(true);
  });
  test("small increase ok only within BOTH 3% and $1", () => {
    expect(withinApproval(20, 20.5, c)).toBe(true); // 2.5%, $0.50
    expect(withinApproval(20, 21, c)).toBe(false); // 5%
    expect(withinApproval(80, 81.6, c)).toBe(false); // 2%, but $1.60
  });
});

describe("products and places", () => {
  const products = ["UberX", "Comfort", "UberXL", "Black"].map((n, i) => ({ product_id: String(i), display_name: n }));
  test("matches spoken ride types", () => {
    expect(pickProduct(products, "uber x")?.display_name).toBe("UberX");
    expect(pickProduct(products, "XL")?.display_name).toBe("UberXL");
    expect(pickProduct(products, "comfort")?.display_name).toBe("Comfort");
    expect(pickProduct(products, "helicopter")).toBeUndefined();
    expect(normProduct("Uber Pool")).toBe("share");
  });
  test("recognizes home and work however they're said", () => {
    for (const s of ["home", "my place", "to home", "back home", "Home."]) expect(savedPlaceId(s)).toBe("home");
    for (const s of ["work", "the office", "my office"]) expect(savedPlaceId(s)).toBe("work");
    expect(savedPlaceId("homeward cafe")).toBeNull();
    expect(clean("to the airport.")).toBe("the airport");
  });
  test("coordinates pass through; far matches are dropped", async () => {
    const r = new PlaceResolver(new FakeGeocoder(), async () => null);
    const ll = await r.resolve("33.68,-117.86");
    expect(ll.kind === "ok" && ll.place.coords?.lat).toBe(33.68);
    const far = await r.resolve("vegas", { lat: 33.65, lng: -117.74 });
    expect(far.kind).toBe("not_found");
    const home = await r.resolve("home");
    expect(home.kind === "not_found" && home.message).toContain("don't have a home address saved");
  });
  test("distance math", () => {
    expect(Math.round(miles({ lat: 33.6762, lng: -117.8675 }, { lat: 33.9416, lng: -118.4085 }) * 10) / 10).toBe(36.1); // checked independently
  });
});

describe("speech", () => {
  test("plates are spelled out for text-to-speech", () => {
    expect(plateSpoken("8klm 214")).toBe("8 K L M 2 1 4");
  });
  test("ride descriptions", () => {
    const r = { request_id: "r", status: "accepted" as const, driver: { name: "Maria" }, vehicle: { color: "Gray", make: "Toyota", model: "Prius", license_plate: "8KLM214" }, pickup: { eta: 4 } };
    expect(describeRide(r)).toBe("Maria is on the way and about 4 minutes out, in a Gray Toyota Prius, plate 8 K L M 2 1 4.");
    expect(describeRide({ request_id: "r", status: "no_drivers_available" })).toContain("Nothing was booked");
  });
  test("mode parsing defaults to demo", () => {
    expect(envFrom(undefined)).toBe("demo");
    expect(envFrom("Production")).toBe("production");
    expect(envFrom("nonsense")).toBe("demo");
  });
});
