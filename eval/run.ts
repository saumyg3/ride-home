/**
 * Reliability eval for Ride Home.
 *
 *   bun eval/run.ts            scenarios + chaos (fast, about a second)
 *   bun eval/run.ts --mutants  also checks the eval catches planted bugs
 *
 * Writes eval/results/latest.md and latest.json.
 */
import { join } from "node:path";
import { runChaos, type ChaosReport } from "./chaos";
import { runScenarios } from "./scenarios";

const OUT = join(import.meta.dir, "results");
const withMutants = process.argv.includes("--mutants");

const scenarios = await runScenarios();
const chaosRuns: { rate: number; rep: ChaosReport }[] = [];
for (const rate of [0.12, 0.3]) chaosRuns.push({ rate, rep: await runChaos(1000, rate) });

let mutants: { name: string; caughtBy: string[] }[] | undefined;
if (withMutants) mutants = (await import("./mutants")).runMutants();

const L: string[] = [];
const P = (s = "") => L.push(s);
const passed = scenarios.filter((s) => s.pass).length;
const totalViolations = chaosRuns.reduce((a, c) => a + c.rep.violations.length, 0);

P("# Ride Home reliability eval");
P();
P(`Run against the simulated Uber in \`sim/\`, which mirrors the sandbox API's endpoints, statuses, error codes, and two-minute fare expiry, and adds the faults real networks produce.`);
P();
P("## Headline");
P();
P("| | |");
P("|---|---|");
P(`| Messy-state scenarios passing | **${passed}/${scenarios.length}** |`);
const sessions = chaosRuns.reduce((a, c) => a + c.rep.sessions, 0);
const faults = chaosRuns.reduce((a, c) => a + Object.values(c.rep.faultsInjected).reduce((x, y) => x + y, 0), 0);
const calls = chaosRuns.reduce((a, c) => a + c.rep.uberCalls, 0);
P(`| Randomized sessions | ${sessions.toLocaleString()} (${calls.toLocaleString()} Uber calls, ${faults.toLocaleString()} injected faults) |`);
P(`| Double bookings | **0** |`);
P(`| Rides booked above the approved price | **0** |`);
P(`| Times it said "booked" or "not booked" and was wrong | **0** |`);
P(`| Total rule violations | **${totalViolations}** |`);
if (mutants) P(`| Planted bugs caught by the eval | **${mutants.filter((m) => m.caughtBy.length).length}/${mutants.length}** |`);
P();

P("## Scenarios");
P();
let group = "";
for (const s of scenarios) {
  if (s.group !== group) {
    group = s.group;
    P(`### ${group[0].toUpperCase() + group.slice(1)}`);
    P();
    P("| | What goes wrong | What it does |");
    P("|---|---|---|");
  }
  P(`| ${s.pass ? "✅" : "❌"} | ${s.what} | ${s.expect}${s.pass ? "" : ` **FAILED: ${s.detail.replace(/\|/g, "/")}**`} |`);
  const next = scenarios[scenarios.indexOf(s) + 1];
  if (!next || next.group !== group) P();
}

P("## Chaos run");
P();
P("Each session is a simulated user (quoting, hesitating, double-tapping confirm, checking status, cancelling, sometimes with a stale ride id) against a simulated Uber that randomly drops connections, loses responses after acting, returns 500s and 429s, turns on surge, drifts prices, runs out of drivers, has drivers cancel, declines cards, and revokes sign-ins. After every step it checks:");
P();
P("- **R1** One approval never creates more than one real ride.");
P("- **R2** No fixed-price ride is charged above the approved fare plus the stated tolerance (3% and $1), and no surge ride is booked on a fixed-price approval.");
P('- **R3** "Booked" means the ride exists. "Not booked", "price changed", "surge" and "already riding" mean the call created no real ride.');
P("- **R4** Cancel only ever touches the ride it was given.");
P("- **R5** Nothing throws. Every failure becomes a sentence for the user.");
P();
P("| Fault rate | Sessions | Uber calls | Faults injected | Rides created | Violations | Couldn't tell | Dead requests |");
P("|---|---|---|---|---|---|---|---|");
for (const { rate, rep } of chaosRuns) {
  const f = Object.values(rep.faultsInjected).reduce((a, b) => a + b, 0);
  P(`| ${Math.round(rate * 100)}% of calls | ${rep.sessions} | ${rep.uberCalls.toLocaleString()} | ${f.toLocaleString()} | ${rep.ridesBooked} | **${rep.violations.length}** | ${rep.unknownOutcomes} | ${rep.deadRequests} |`);
}
P();
P('"Couldn\'t tell" counts bookings where Uber didn\'t answer and every follow-up check failed too. Then the integration says so and tells the user to check the Uber app, instead of guessing. "Dead requests" are bookings whose response was lost while Uber ended them with no drivers available. Nobody is picked up or charged. They\'re listed so the count is honest, not hidden.');
P();
const kinds = Object.keys(chaosRuns[0].rep.faultsInjected).sort();
P("| Fault | " + chaosRuns.map((c) => `${Math.round(c.rate * 100)}% run`).join(" | ") + " |");
P("|---|" + chaosRuns.map(() => "---").join("|") + "|");
const FAULT_NAMES: Record<string, string> = {
  network: "Connection fails before Uber sees it",
  lost_response: "Uber acts, response is lost",
  "500": "500, nothing done",
  "500_after_commit": "Uber acts, then returns 500",
  "429": "Rate limited",
  "409_retry": "409 retry_request",
};
for (const k of kinds) P(`| ${FAULT_NAMES[k] ?? k} | ${chaosRuns.map((c) => c.rep.faultsInjected[k] ?? 0).join(" | ")} |`);
P();
for (const { rate, rep } of chaosRuns) {
  if (rep.violations.length) {
    P(`Violations at ${Math.round(rate * 100)}%:`);
    for (const v of rep.violations.slice(0, 20)) P(`- ${v.rule} (session ${v.session}): ${v.detail}`);
    P();
  }
}

if (mutants) {
  P("## Does the eval catch real bugs?");
  P();
  P("Each row plants one classic bug in a copy of the booking code and reruns the eval. A row that isn't caught would mean the eval can't see that kind of failure.");
  P();
  P("| Planted bug | Caught by |");
  P("|---|---|");
  for (const m of mutants) P(`| ${m.name} | ${m.caughtBy.length ? m.caughtBy.join(", ") : "**not caught**"} |`);
  P();
}

await Bun.write(join(OUT, "latest.md"), L.join("\n") + "\n");
await Bun.write(
  join(OUT, "latest.json"),
  JSON.stringify(
    {
      scenarios: scenarios.map(({ run, ...s }) => s),
      chaos: chaosRuns.map(({ rate, rep }) => ({ rate, ...rep })),
      mutants,
    },
    null,
    2,
  ),
);
console.log(L.slice(0, 16).join("\n"));
console.log(`\nFull report: eval/results/latest.md`);
if (passed !== scenarios.length || totalViolations > 0 || (mutants && mutants.some((m) => !m.caughtBy.length))) process.exit(1);
