// Mutation check: plants classic booking bugs in a throwaway copy of the
// project and confirms the eval fails for each. Never edits the real source.

import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

type Mutant = { name: string; file: string; edits: [from: string, to: string][] };

export const MUTANTS: Mutant[] = [
  {
    name: "Books a price the user hasn't had time to answer",
    file: "src/rides.ts",
    edits: [['if (this.now() - shownAt < this.config.minConfirmGapMs) return { kind: "needs_answer", quote };', "void shownAt;"]],
  },
  {
    name: "Re-quoting the same ride restarts the wait, so a real yes is refused",
    file: "src/rides.ts",
    edits: [["if (first === undefined || this.now() - first > OFFER_MEMORY_MS) this.offered.set(key, this.now());", "this.offered.set(key, this.now());"]],
  },
  {
    name: "Resends the booking after a timeout instead of checking for the ride",
    file: "src/rides.ts",
    edits: [["if (err instanceof AmbiguousWrite) return this.reconcile(quote, preCheckClear, repriced);", "if (err instanceof AmbiguousWrite) continue;"]],
  },
  {
    name: "Assumes a timed-out booking failed, without checking",
    file: "src/rides.ts",
    edits: [["if (err instanceof AmbiguousWrite) return this.reconcile(quote, preCheckClear, repriced);", 'if (err instanceof AmbiguousWrite) return { kind: "not_booked", code: "no_response", say: "Nothing was booked." };']],
  },
  {
    name: "Books any re-quoted price without asking again",
    file: "src/rides.ts",
    edits: [["if (next.surge || !q.fare || !next.fare || !withinApproval(q.fare.price.value, next.fare.price.value, this.config)) {", "if (next.surge || !q.fare || !next.fare) {"]],
  },
  {
    name: "Price limits use OR instead of AND (3% OR $1)",
    file: "src/rides.ts",
    edits: [["return up <= c.maxIncreaseAbs + 1e-9 && up <= approved * c.maxIncreasePct + 1e-9;", "return up <= c.maxIncreaseAbs + 1e-9 || up <= approved * c.maxIncreasePct + 1e-9;"]],
  },
  {
    name: "Doesn't check the card matches the quote",
    file: "src/rides.ts",
    edits: [["    if (mismatch) {", "    if (false && mismatch) {"]],
  },
  {
    name: "Confirming the same quote twice books again",
    file: "src/rides.ts",
    edits: [["      if (quote.usedByRequestId) {", "      if (false && quote.usedByRequestId) {"]],
  },
  {
    name: "Bookings aren't serialized (double-tap race)",
    file: "src/rides.ts",
    edits: [["    return this.serial(() => this.bookInner(confirmed));", "    return this.bookInner(confirmed);"]],
  },
  {
    name: "Cancels whatever ride is current, ignoring the id it was given",
    file: "src/rides.ts",
    edits: [
      ["      if (!current || current.request_id !== requestId) {", "      if (!current) {"],
      ["        await this.d.uber.cancel(requestId);", "        await this.d.uber.cancel(current.request_id);"],
    ],
  },
  {
    name: "Retries the booking call on 5xx inside the HTTP client",
    file: "src/uber.ts",
    edits: [['if (res.status >= 500) throw new AmbiguousWrite(`Uber returned ${res.status} while booking`);', "if (res.status >= 500 && attempt < this.retries) { await this.sleep(backoff(attempt)); continue; }"]],
  },
];

export function runMutants() {
  const results: { name: string; caughtBy: string[] }[] = [];
  for (const m of MUTANTS) {
    const dir = mkdtempSync(join(tmpdir(), "ride-home-mutant-"));
    try {
      for (const d of ["src", "sim", "eval"]) cpSync(join(ROOT, d), join(dir, d), { recursive: true });
      for (const f of ["package.json", "tsconfig.json"]) cpSync(join(ROOT, f), join(dir, f));
      symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
      const path = join(dir, m.file);
      let src = readFileSync(path, "utf8");
      for (const [from, to] of m.edits) {
        if (!src.includes(from)) throw new Error(`mutant "${m.name}" no longer applies; update eval/mutants.ts`);
        src = src.replace(from, to);
      }
      writeFileSync(path, src);

      const script = `
        import { runScenarios } from "./eval/scenarios";
        import { runChaos } from "./eval/chaos";
        const s = await runScenarios();
        const c = await runChaos(500, 0.12);
        console.log(JSON.stringify({ scenarios: s.filter((x) => !x.pass).map((x) => x.id), chaos: [...new Set(c.violations.map((v) => v.rule))] }));`;
      writeFileSync(join(dir, "probe.ts"), script);
      const p = Bun.spawnSync(["bun", "probe.ts"], { cwd: dir, timeout: 120_000 });
      const out = p.stdout.toString().trim().split("\n").pop() ?? "";
      let caughtBy: string[] = [];
      try {
        const j = JSON.parse(out);
        if (j.scenarios.length) caughtBy.push(`${j.scenarios.length} scenario${j.scenarios.length > 1 ? "s" : ""} (${j.scenarios.slice(0, 3).join(", ")}${j.scenarios.length > 3 ? ", …" : ""})`);
        if (j.chaos.length) caughtBy.push(`chaos rules ${j.chaos.sort().join(", ")}`);
      } catch {
        // A crash or type error counts as caught: the build fails loudly.
        caughtBy = [`eval crashed: ${p.stderr.toString().split("\n").find((l) => l.trim()) ?? "unknown"}`];
      }
      results.push({ name: m.name, caughtBy });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return results;
}
