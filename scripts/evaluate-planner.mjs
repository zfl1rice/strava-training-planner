import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { generatePlanWithCorrections, deterministicPlanProvider } from "@pkg/shared";
import { planningScenarios } from "../tests/fixtures/planning-scenarios.mjs";

// Import this function to compare another provider against the same inputs.
// Default evaluation is always local, even if the worker is configured for OpenAI.
export async function evaluatePlanner(provider = deterministicPlanProvider, scenarios = planningScenarios()) {
  const results = [];
  for (const scenario of scenarios) {
    const calls = [];
    let proposalAttempts = 0;
    const started = Date.now();
    const measuredProvider = (input, attempt) => {
      proposalAttempts = attempt.attempt;
      return provider(input, attempt);
    };
    let outcome;
    try {
      const plan = await generatePlanWithCorrections(scenario.input, measuredProvider, { reportCall: async call => { calls.push(call); } });
      outcome = { valid: true, totals: { totalMinutes: plan.totalMinutes,
        sports: Object.fromEntries(Object.entries(plan.budgets).map(([sport, budget]) => [sport, budget.plannedMinutes])) }, analysis: plan.analysis, plan };
    } catch (error) {
      outcome = { valid: false, errors: error.issues ?? [{ code: error.category ?? "EVALUATION_ERROR", message: error.message }] };
    }
    const tokens = Object.fromEntries(["inputTokens", "cachedInputTokens", "outputTokens", "totalTokens"].map(key =>
      [key, calls.length && calls.every(call => call[key] !== null) ? calls.reduce((sum, call) => sum + call[key], 0) : null]));
    results.push({ id: scenario.id, description: scenario.description, model: calls.at(-1)?.model ?? null,
      proposalAttempts, latencyMs: Date.now() - started, tokens, calls, ...outcome });
  }
  return results;
}

// Keep the full JSON on stdout for files/tools; readable telemetry goes to stderr.
export function formatEvaluationSummary(result) {
  const tokenCount = value => value == null ? "unknown" : value.toLocaleString("en-US");
  const responseIds = result.calls.map(call => call.responseId ?? "not returned");
  return [
    `Scenario: ${result.id}`,
    `Model: ${result.model ?? "none (local / no model response)"}`,
    `Proposal attempts: ${result.proposalAttempts} | Provider calls: ${result.calls.length}`,
    `Latency: ${(result.latencyMs / 1000).toFixed(1)} s (whole scenario)`,
    `OpenAI response IDs (call order): ${responseIds.length ? responseIds.join(", ") : "none"}`,
    `Input tokens: ${tokenCount(result.tokens.inputTokens)}`,
    `Cached input: ${tokenCount(result.tokens.cachedInputTokens)}`,
    `Output tokens: ${tokenCount(result.tokens.outputTokens)}`,
    `Total tokens: ${tokenCount(result.tokens.totalTokens)}`,
    `Validation: ${result.valid ? "PASS" : "FAIL"}`,
    "Tokens are summed across calls; unknown means usage was not fully reported.",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const live = args[0] === "--openai";
  if (live) args.shift();
  const scenarioId = args[0] === "--scenario" ? args[1] : undefined;
  if (args.length && (!scenarioId || args.length !== 2)) throw new Error("Usage: evaluate-planner.mjs [--openai] [--scenario ID]");
  const scenarios = planningScenarios().filter(scenario => !scenarioId || scenario.id === scenarioId);
  if (!scenarios.length) throw new Error(`Unknown scenario: ${scenarioId}`);
  let provider = deterministicPlanProvider;
  if (live) {
    const { config } = await import("dotenv");
    config({ path: new URL("../apps/worker/.env.local", import.meta.url), quiet: true });
    const { readPlannerConfig } = await import("../apps/worker/dist/planner-config.js");
    const { createOpenAIPlanProvider } = await import("../apps/worker/dist/openai-planner.js");
    provider = createOpenAIPlanProvider(readPlannerConfig({ ...process.env, PLANNER_PROVIDER: "openai" }));
    console.error(`Live OpenAI evaluation: ${scenarios.length} scenario(s), up to three paid proposal calls each.`);
  }
  const results = await evaluatePlanner(provider, scenarios);
  for (const result of results) console.error(`\n${formatEvaluationSummary(result)}\n`);
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => !result.valid)) process.exitCode = 1;
}
