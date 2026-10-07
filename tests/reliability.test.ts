import { describe, expect, test } from "bun:test";
import { SCENARIOS, runScenarios } from "../eval/scenarios";
import { runChaos } from "../eval/chaos";

// The eval doubles as the integration test suite: every scenario must pass,
// and a short chaos run must find no rule violations.

describe("reliability scenarios", async () => {
  const results = await runScenarios();
  for (const r of results) {
    test(`${r.group}: ${r.what}`, () => {
      expect(r.detail).toBe("");
      expect(r.pass).toBe(true);
    });
  }
  test("every scenario ran", () => expect(results.length).toBe(SCENARIOS.length));
});

describe("chaos", () => {
  test("200 randomized sessions with 20% faults break no rules", async () => {
    const rep = await runChaos(200, 0.2);
    expect(rep.violations).toEqual([]);
    expect(Object.values(rep.faultsInjected).reduce((a, b) => a + b, 0)).toBeGreaterThan(100);
  });
});
