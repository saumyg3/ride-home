/**
 * verify.ts: checks Ride Home the way VoiceOS will run it.
 *
 * 1. Manifest: fields, cross-field rules, confirmation cards (bindings,
 *    exactly one confirm + cancel, only on tools that act), intents.
 * 2. Every result card against the documented glance-block limits.
 * 3. Real MCP over stdio in demo mode: handshake, tools match the manifest,
 *    preview fixtures, then a whole conversation: quote, book, re-confirm,
 *    status, wrong-ride cancel, real cancel, tampered confirmation.
 * 4. Sandbox mode with no sign-in gives a clear message.
 *
 * Exits non-zero on any failure.  Usage: bun verify.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = import.meta.dir;
const manifest = await Bun.file(join(ROOT, "voiceos.integration.json")).json();
const preview = await Bun.file(join(ROOT, "voiceos.integration.preview.json")).json();

let failures = 0;
const pass = (msg: string) => console.log(`  ok   ${msg}`);
const fail = (msg: string) => (failures++, console.log(`  FAIL ${msg}`));
const check = (cond: unknown, msg: string) => (cond ? pass(msg) : fail(msg));

// ---------- 1. manifest ----------
console.log("Manifest");
const errs: string[] = [];
const str = (v: unknown, min = 1, max = Infinity) => typeof v === "string" && v.trim().length >= min && v.length <= max;
if (manifest.schemaVersion !== 1) errs.push("schemaVersion must be 1");
if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(manifest.id ?? "")) errs.push("id must be reverse-DNS");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) errs.push("version must be semver");
if (!str(manifest.name)) errs.push("name required");
if (!str(manifest.summary, 1, 140) || /\n/.test(manifest.summary)) errs.push(`summary must be one line, 1-140 chars (is ${manifest.summary?.length})`);
if (!str(manifest.publisher?.id) || !str(manifest.publisher?.name)) errs.push("publisher.id and publisher.name required");
if ("verified" in (manifest.publisher ?? {})) errs.push("publisher.verified is set by VoiceOS, not the author");
const rt = manifest.runtime ?? {};
if (!(rt.kind === "local-mcp" && str(rt.command)) && !(rt.kind === "remote-mcp" && str(rt.url))) errs.push("runtime invalid");
for (const k of ["homepage", "repository"]) if (manifest[k] && !URL.canParse(manifest[k])) errs.push(`${k} must be a URL`);

const perms = new Set((manifest.permissions ?? []).map((p: any) => p.kind));
for (const p of manifest.permissions ?? []) {
  if (!["network", "background", "notify", "store", "webhook"].includes(p.kind)) errs.push(`unknown permission ${p.kind}`);
  if (p.kind === "network" && !(p.domains?.length > 0)) errs.push("network permission needs domains");
}

// Tools that change something in the world must confirm; reads must not.
const ACTS = new Set(["request_ride", "cancel_ride"]);
const UI_TYPES = new Set(["card", "stack", "text", "markdown", "keyValue", "metadata", "list", "listItem", "badge", "divider", "textField", "passwordField", "select", "toggle", "chips", "actions", "button"]);
const COLORS = new Set(["default", "muted", "subtle", "accent", "success", "warning", "danger", "onAccent"]);

function walkUi(node: any, out: { types: string[]; bindings: string[]; roles: string[]; colors: string[] }) {
  if (!node || typeof node !== "object") return;
  if (node.type) out.types.push(node.type);
  for (const v of Object.values(node)) {
    if (typeof v === "string") for (const m of v.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) out.bindings.push(m[1].split(".")[0]);
  }
  if (node.color) out.colors.push(node.color);
  if (node.type === "actions") for (const it of node.items ?? []) out.roles.push(it.role), it.color && out.colors.push(it.color);
  for (const k of ["children", "footer", "accessories"]) for (const c of node[k] ?? []) walkUi(c, out);
}

const toolNames = new Set<string>();
for (const [i, t] of (manifest.tools ?? []).entries()) {
  if (!/^[a-z][a-z0-9_]*$/.test(t.name ?? "")) errs.push(`tools.${i}.name must be snake_case`);
  if (toolNames.has(t.name)) errs.push(`tools.${i}.name duplicate`);
  toolNames.add(t.name);
  if (!str(t.description, 40)) errs.push(`tools.${i}.description too thin to route on`);
  if (t.inputSchema?.type !== "object") errs.push(`tools.${i}.inputSchema must be an object schema`);
  const props = Object.keys(t.inputSchema?.properties ?? {});
  for (const [p, def] of Object.entries<any>(t.inputSchema?.properties ?? {})) if (!str(def.description)) errs.push(`tools.${i}.inputSchema.${p} needs a description`);
  if (t.execution?.mode === "background" && !perms.has("background")) errs.push(`tools.${i} is background but the background permission is missing`);

  if (ACTS.has(t.name) && !t.confirmation) errs.push(`${t.name} acts, so it must declare a confirmation`);
  if (!ACTS.has(t.name) && t.confirmation) errs.push(`${t.name} only reads, so it must not declare a confirmation`);
  if (t.confirmation) {
    if (t.confirmation.schemaVersion !== 1) errs.push(`${t.name}.confirmation.schemaVersion must be 1`);
    const u = { types: [] as string[], bindings: [] as string[], roles: [] as string[], colors: [] as string[] };
    walkUi(t.confirmation.root, u);
    for (const ty of u.types) if (!UI_TYPES.has(ty)) errs.push(`${t.name}.confirmation uses unknown block ${ty}`);
    for (const b of u.bindings) if (!props.includes(b)) errs.push(`${t.name}.confirmation binds {{${b}}}, which isn't an input`);
    if (u.roles.filter((r) => r === "confirm").length !== 1 || u.roles.filter((r) => r === "cancel").length !== 1)
      errs.push(`${t.name}.confirmation needs exactly one confirm and one cancel action`);
    for (const c of u.colors) if (!COLORS.has(c)) errs.push(`${t.name}.confirmation color ${c} isn't a color token`);
    // Every value the user is approving must be on the card.
    if (t.name === "request_ride") for (const k of ["product", "price", "pickup", "destination"]) if (!u.bindings.includes(k)) errs.push(`request_ride card doesn't show {{${k}}}`);
  }
}
const prefNames = new Set<string>();
for (const [i, p] of (manifest.preferences ?? []).entries()) {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(p.name ?? "")) errs.push(`preferences.${i}.name invalid`);
  if (!["text", "password", "boolean", "select", "number"].includes(p.type)) errs.push(`preferences.${i}.type invalid`);
  if (p.type === "select" && !p.options?.length) errs.push(`preferences.${i} select needs options`);
  if (p.type === "select" && p.default !== undefined && !p.options.some((o: any) => o.value === p.default)) errs.push(`preferences.${i} default isn't an option`);
  prefNames.add(p.name);
}
for (const f of manifest.auth?.fields ?? []) if (prefNames.has(f.key)) errs.push(`auth field ${f.key} collides with a preference`);
for (const [i, it] of (manifest.intents ?? []).entries()) {
  const tool = manifest.tools.find((t: any) => t.name === it.tool);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(it.name ?? "")) errs.push(`intents.${i}.name invalid`);
  if (!tool) { errs.push(`intents.${i}.tool not declared`); continue; }
  if (tool.execution?.mode === "background") errs.push(`intents.${i} points at a background tool`);
  const props = Object.keys(tool.inputSchema?.properties ?? {});
  const slots = it.slots ?? {};
  const fixed = it.fixedArgs ?? {};
  for (const s of [...Object.keys(slots), ...Object.keys(fixed)]) if (!props.includes(s)) errs.push(`intents.${i}: ${s} is not a tool input`);
  for (const r of tool.inputSchema?.required ?? []) if (!(r in fixed) && !slots[r]?.required) errs.push(`intents.${i}: required input ${r} not fixed or a required slot`);
  for (const [lang, utts] of Object.entries<string[]>(it.utterances ?? {})) if (!utts.length || utts.length > 20) errs.push(`intents.${i}.utterances.${lang} needs 1-20`);
  if (!Object.keys(it.response ?? {}).length) errs.push(`intents.${i}.response required`);
}
const vocab = manifest.asr?.vocabulary ?? [];
if (vocab.length > 50 || vocab.some((v: string) => !str(v, 1, 80) || /,/.test(v))) errs.push("asr.vocabulary invalid");
errs.length ? errs.forEach(fail) : pass("manifest fields, permissions, confirmations, intents");
check(preview.schemaVersion === 1, "preview fixture schemaVersion is 1");
check([...toolNames].every((n) => preview.tools[n]), "every tool has a preview fixture");

// ---------- 2. glance block checks (from the glance block reference) ----------
const GLYPHS = new Set(
  "calendar clock timer bed car mail message music sun moon cloud rain star folder file globe pin phone person heart bolt check x mic note list battery chart dollar home wifi coffee plane sparkle".split(" "),
);
const TONES = new Set(["neutral", "good", "bad"]);
const CHARTS = new Set(["bars", "line", "splitBar"]);
function blockErrors(b: any): string[] {
  const e: string[] = [];
  const s = (v: unknown, max: number, field: string, optional = false) => {
    if (v === undefined && optional) return;
    if (typeof v !== "string" || v.trim() !== v || v.length < 1 || v.length > max) e.push(`${b.type}.${field} must be a trimmed 1-${max} char string (got ${JSON.stringify(v)?.slice(0, 40)})`);
  };
  const glyph = (v: unknown, field: string) => v !== undefined && !GLYPHS.has(v as string) && e.push(`${b.type}.${field} unknown glyph ${v}`);
  switch (b.type) {
    case "header":
      s(b.title, 60, "title"); s(b.trailing, 40, "trailing", true); s(b.appIcon, 40, "appIcon", true); glyph(b.icon, "icon");
      break;
    case "keyValue":
      if (!Array.isArray(b.pairs) || b.pairs.length < 1 || b.pairs.length > 5) e.push("keyValue.pairs needs 1-5");
      for (const [k, v] of b.pairs ?? []) { s(k, 32, "pair label"); s(v, 64, "pair value"); }
      break;
    case "list":
      s(b.header, 60, "header", true);
      if (!Array.isArray(b.rows) || b.rows.length < 1 || b.rows.length > 6) e.push("list.rows needs 1-6");
      for (const r of b.rows ?? []) {
        s(r.title, 60, "row.title"); s(r.subtitle, 72, "row.subtitle", true); s(r.trailing, 24, "row.trailing", true); glyph(r.icon, "row.icon");
      }
      break;
    case "stats":
      if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 3) e.push("stats.items needs 1-3");
      for (const it of b.items ?? []) {
        s(it.label, 48, "label"); s(it.value, 20, "value"); s(it.delta, 12, "delta", true);
        if (it.tone && !TONES.has(it.tone)) e.push("stats tone invalid");
      }
      break;
    case "badges":
      if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 3) e.push("badges.items needs 1-3");
      for (const it of b.items ?? []) { s(it.text, 24, "text"); if (it.tone && !TONES.has(it.tone)) e.push("badge tone invalid"); }
      break;
    default:
      e.push(`unchecked block type ${b.type}`);
  }
  return e;
}
function checkGlance(raw: string, label: string, expected?: number) {
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    return fail(`${label}: result text is not JSON`);
  }
  check(raw.length <= 32000, `${label}: payload under 32,000 chars (${raw.length})`);
  const blocks = payload?._voiceos_glance?.blocks;
  if (!Array.isArray(blocks)) return fail(`${label}: no _voiceos_glance.blocks`);
  check(blocks.length >= 1 && blocks.length <= 3, `${label}: 1-3 glance blocks (${blocks.length})`);
  if (expected !== undefined) check(blocks.length === expected, `${label}: expected ${expected} blocks`);
  check(blocks.filter((b: any) => CHARTS.has(b.type)).length <= 1, `${label}: at most one chart`);
  const be = blocks.flatMap(blockErrors);
  be.length ? be.forEach((m) => fail(`${label}: ${m}`)) : pass(`${label}: every block within documented limits`);
  // the model narrates from JSON, so data must not live only in the card
  check(Object.keys(payload).some((k) => k !== "_voiceos_glance"), `${label}: model-facing data present outside the card`);
  return payload;
}

// ---------- 3. MCP over stdio ----------
async function connect(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: manifest.runtime.command,
    args: manifest.runtime.args,
    cwd: ROOT,
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "ride-home-verify", version: "1.0.0" });
  await client.connect(transport);
  return client;
}
const text = (r: any) => r.content?.find((c: any) => c.type === "text")?.text ?? "";
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r: any = await c.callTool({ name, arguments: args });
  const raw = text(r);
  checkGlance(raw, `${name}`);
  return JSON.parse(raw);
};

const EMPTY_CONFIG = mkdtempSync(join(tmpdir(), "ride-home-verify-"));
const DEMO = { UBER_ENVIRONMENT: "demo", RIDE_HOME_CONFIG_DIR: EMPTY_CONFIG, DEFAULT_PICKUP: "" };

console.log("\nMCP handshake and tools (demo mode)");
let client: Client;
try {
  client = await connect(DEMO);
} catch (err) {
  fail(`server failed to start or handshake: ${(err as Error).message}`);
  const proc = Bun.spawnSync([manifest.runtime.command, ...manifest.runtime.args], { cwd: ROOT, stdin: "ignore", env: { ...process.env, ...DEMO }, timeout: 5000 });
  console.log(proc.stderr.toString().split("\n").slice(0, 8).map((l) => `       ${l}`).join("\n"));
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
pass("handshake over stdio");
const { tools } = await client.listTools();
const served = new Set(tools.map((t) => t.name));
check([...toolNames].every((n) => served.has(n)) && served.size === toolNames.size, `served tools match manifest (${[...served].join(", ")})`);
for (const t of tools) {
  const m = manifest.tools.find((x: any) => x.name === t.name);
  check(m && t.description === m.description, `${t.name}: description identical to manifest`);
  const servedProps = Object.keys((t.inputSchema as any)?.properties ?? {}).sort().join(",");
  const manifestProps = Object.keys(m?.inputSchema?.properties ?? {}).sort().join(",");
  check(servedProps === manifestProps, `${t.name}: inputs match manifest (${servedProps || "none"})`);
  const servedReq = ((t.inputSchema as any)?.required ?? []).sort().join(",");
  const manifestReq = (m?.inputSchema?.required ?? []).sort().join(",");
  check(servedReq === manifestReq, `${t.name}: required inputs match manifest`);
}

console.log("\nPreview fixtures (must be harmless)");
for (const [name, fx] of Object.entries<any>(preview.tools)) {
  const r: any = await client.callTool({ name, arguments: fx.args });
  const p = checkGlance(text(r), name, fx.expectedGlanceBlocks);
  if (name === "request_ride") check(p?.booked === false, "request_ride fixture books nothing");
  if (name === "cancel_ride") check(p?.canceled === false, "cancel_ride fixture cancels nothing");
}
await client.close();

console.log("\nA full conversation over MCP");
{
  const c = await connect({ ...DEMO, RIDE_CONFIRM_GAP_MS: "1500" });
  const q = await call(c, "ride_quote", { destination: "home" });
  check(q.ok && q.book_with?.price?.startsWith("$") && /Want me to book it/.test(q.say), `quote: "${q.say}"`);

  const tampered = await call(c, "request_ride", { ...q.book_with, price: "$1.00" });
  check(tampered.booked === false && tampered.code === "confirmation_mismatch", "a price that doesn't match the quote is refused");

  const rushed = await call(c, "request_ride", q.book_with);
  check(rushed.booked === false && rushed.code === "user_has_not_answered" && /Want me to book it/.test(rushed.say), `booking chained straight after the quote is turned into a question: "${rushed.say}"`);
  await Bun.sleep(1600);

  const b = await call(c, "request_ride", q.book_with);
  check(b.booked === true && b.ride?.request_id, `booked: "${b.say}"`);

  const again = await call(c, "request_ride", q.book_with);
  check(again.booked === true && again.ride?.request_id === b.ride.request_id, "confirming the same quote twice returns the same ride");

  const q2 = await call(c, "ride_quote", { destination: "John Wayne Airport" });
  check(q2.code === "already_on_trip", "asking for another ride while one is active is stopped");

  const st = await call(c, "ride_status");
  check(st.request_id === b.ride.request_id && st.active, `status: "${st.say}"`);

  const wrong = await call(c, "cancel_ride", { request_id: "some-other-ride", summary: "x" });
  check(wrong.canceled === false && wrong.code === "not_current", "cancel refuses a ride id that isn't the current ride");

  const cx = await call(c, "cancel_ride", { request_id: st.request_id, summary: st.summary });
  check(cx.canceled === true, "cancel works on the current ride");

  const after = await call(c, "ride_status");
  check(after.status === "rider_canceled" && after.active === false, `after cancel: "${after.say}"`);

  const amb = await call(c, "ride_quote", { destination: "Main Street" });
  check(amb.code === "ambiguous_place" && amb.options.length === 2, "an ambiguous destination asks which one");
  await c.close();
}

console.log("\nSandbox mode without signing in");
{
  const c = await connect({ UBER_ENVIRONMENT: "sandbox", RIDE_HOME_CONFIG_DIR: EMPTY_CONFIG, DEFAULT_PICKUP: "work", UBER_ACCESS_TOKEN: "" });
  const r = await call(c, "ride_status");
  check(r.ok === false && r.code === "auth_required" && /bun login/.test(r.say), `clear sign-in message: "${r.say}"`);
  await c.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
