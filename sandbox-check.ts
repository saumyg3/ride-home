/**
 * Live check against Uber's real sandbox API.
 *
 *   bun login.ts sandbox                 (once)
 *   DEFAULT_PICKUP="<an address>" bun sandbox-check.ts
 *
 * Runs the core flows through RideService against sandbox-api.uber.com, using
 * the sandbox's own controls (PUT /v1.2/sandbox/...) to force ride states,
 * no-drivers, and surge. No real car is dispatched and nothing is charged.
 * Prints a pass/fail line per check and writes eval/results/sandbox.md.
 */
import { join } from "node:path";
import { FileTokenProvider, StaticTokenProvider } from "./src/auth";
import { NominatimGeocoder, PlaceResolver } from "./src/places";
import { MemoryStore, RideService, type Confirmed } from "./src/rides";
import type { Quote, RideStatus } from "./src/types";
import { BASE_URL, UberClient, type TokenProvider } from "./src/uber";

const pickup = process.env.DEFAULT_PICKUP?.trim();
const destination = process.env.SANDBOX_DESTINATION?.trim() || "home";
if (!pickup) {
  console.error('Set DEFAULT_PICKUP to a real street address (and save a "home" place in Uber, or set SANDBOX_DESTINATION).');
  process.exit(1);
}

const tokens: TokenProvider = process.env.UBER_ACCESS_TOKEN
  ? new StaticTokenProvider(process.env.UBER_ACCESS_TOKEN)
  : new FileTokenProvider("sandbox", process.env.UBER_CLIENT_ID, process.env.UBER_CLIENT_SECRET);
const uber = new UberClient({ baseUrl: BASE_URL.sandbox, tokens });
const service = new RideService({
  uber,
  places: new PlaceResolver(new NominatimGeocoder(), (id) => uber.place(id)),
  store: new MemoryStore(),
  config: { defaultPickup: pickup },
});

async function sandboxPut(path: string, body: unknown) {
  const res = await fetch(`${BASE_URL.sandbox}/v1.2/sandbox/${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${await tokens.get()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 204) throw new Error(`sandbox PUT ${path}: HTTP ${res.status} ${await res.text()}`);
}
const setStatus = (id: string, status: RideStatus) => sandboxPut(`requests/${id}`, { status });
const confirmOf = (q: Quote): Confirmed => ({ quote_id: q.id, price: q.priceDisplay, product: q.product.name, pickup: q.pickup.label, destination: q.destination.label });

const results: { name: string; ok: boolean; detail: string }[] = [];
async function check(name: string, fn: () => Promise<string>) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`  ok   ${name}: ${detail}`);
  } catch (e) {
    results.push({ name, ok: false, detail: (e as Error).message });
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
  }
}
function must(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function freshQuote(): Promise<Quote> {
  const r = await service.quote({ destination });
  must(r.kind === "quote", `quote failed: ${JSON.stringify(r).slice(0, 200)}`);
  return r.quote;
}
async function clearActive() {
  const cur = await uber.current();
  if (cur && cur.status !== "in_progress") await uber.cancel(cur.request_id).catch(() => {});
  else if (cur) await setStatus(cur.request_id, "completed");
}

console.log(`Uber sandbox check: ${pickup} -> ${destination}\n`);
await clearActive();

let productId = "";
await check("quote", async () => {
  const q = await freshQuote();
  productId = q.product.id;
  return `${q.product.name} ${q.priceDisplay}, pickup ${q.pickupEtaMin ?? "?"} min`;
});

await check("book, driver accepts, arrives, cancel", async () => {
  const q = await freshQuote();
  const b = await service.book(confirmOf(q));
  must(b.kind === "booked", `book: ${JSON.stringify(b).slice(0, 200)}`);
  await setStatus(b.ride.request_id, "accepted");
  const s1 = await service.status();
  must(s1.kind === "ride" && s1.ride.status === "accepted", `status after accept: ${JSON.stringify(s1).slice(0, 160)}`);
  const again = await service.book(confirmOf(q));
  must(again.kind === "booked" && again.ride.request_id === b.ride.request_id, "re-confirm returned a different ride");
  await setStatus(b.ride.request_id, "arriving");
  const c = await service.cancel(b.ride.request_id);
  must(c.kind === "canceled", `cancel: ${JSON.stringify(c).slice(0, 160)}`);
  return `ride ${b.ride.request_id.slice(0, 8)} booked once, canceled`;
});

await check("driver cancels", async () => {
  const b = await service.book(confirmOf(await freshQuote()));
  must(b.kind === "booked", "book failed");
  await setStatus(b.ride.request_id, "accepted");
  await setStatus(b.ride.request_id, "driver_canceled");
  const s = await service.status();
  must(s.kind === "ride" && s.ride.status === "driver_canceled", `status: ${JSON.stringify(s).slice(0, 160)}`);
  return "reported driver_canceled";
});

await check("no drivers available", async () => {
  await sandboxPut(`products/${productId}`, { drivers_available: false });
  try {
    const b = await service.book(confirmOf(await freshQuote()));
    must(b.kind === "booked", "request wasn't accepted");
    const t = await service.track(1);
    must(t.kind === "tracked" && t.ride.status === "no_drivers_available", `track: ${JSON.stringify(t).slice(0, 160)}`);
    return "reported no_drivers_available";
  } finally {
    await sandboxPut(`products/${productId}`, { drivers_available: true });
  }
});

await check("surge needs Uber's accept step", async () => {
  await sandboxPut(`products/${productId}`, { surge_multiplier: 2.2 });
  try {
    await clearActive();
    const q = await freshQuote();
    const b = await service.book(confirmOf(q));
    must(b.kind === "surge_acceptance" || b.kind === "price_changed", `expected surge handling, got ${b.kind}`);
    must(!(await uber.current()), "a ride was created without accepting surge");
    return `${b.kind}${b.kind === "surge_acceptance" && b.href ? `, link ${b.href}` : ""}`;
  } finally {
    await sandboxPut(`products/${productId}`, { surge_multiplier: 1.0 });
  }
});

await check("expired fare is refreshed, not booked blind", async () => {
  await clearActive();
  const q = await freshQuote();
  // Make the quote look expired locally; the service must re-estimate before booking.
  q.fare!.expiresAt = Date.now() - 1;
  const b = await service.book(confirmOf(q));
  must(b.kind === "booked" || b.kind === "price_changed", `got ${b.kind}`);
  if (b.kind === "booked") await uber.cancel(b.ride.request_id);
  return b.kind === "booked" ? `booked at ${b.repriced?.to ?? q.priceDisplay}` : `asked again: ${b.was} -> ${b.quote.priceDisplay}`;
});

await clearActive();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} sandbox checks passed`);
await Bun.write(
  join(import.meta.dir, "eval", "results", "sandbox.md"),
  [
    `# Uber sandbox check, ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `${passed}/${results.length} passed. Pickup: ${pickup}. Destination: ${destination}.`,
    "",
    "| Check | Result | Detail |",
    "|---|---|---|",
    ...results.map((r) => `| ${r.name} | ${r.ok ? "✅" : "❌"} | ${r.detail.replace(/\|/g, "/")} |`),
    "",
  ].join("\n"),
);
process.exit(passed === results.length ? 0 : 1);
