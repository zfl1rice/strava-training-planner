import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { generatePlanWithCorrections, deterministicPlanProvider, GenerationInputSchema } from "@pkg/shared";
import { planningScenarios } from "../tests/fixtures/planning-scenarios.mjs";

// Import this function to compare another provider against the same inputs.
// Default evaluation is always local, even if the worker is configured for OpenAI.
export async function evaluatePlanner(provider = deterministicPlanProvider, scenarios = planningScenarios()) {
  const results = [];
  for (const scenario of scenarios) {
    const calls = [];
    const attempts = [];
    let proposalAttempts = 0;
    const started = Date.now();
    const measuredProvider = (input, attempt) => {
      proposalAttempts = attempt.attempt;
      return provider(input, attempt);
    };
    let outcome;
    try {
      const plan = await generatePlanWithCorrections(scenario.input, measuredProvider, {
        reportCall: async call => { calls.push(call); },
        reportValidation: result => { attempts.push({ attempt: result.attempt, status: result.valid ? "VALID" : "INVALID", errors: result.issues }); },
      });
      outcome = { valid: true, totals: { totalMinutes: plan.totalMinutes,
        sports: Object.fromEntries(Object.entries(plan.budgets).map(([sport, budget]) => [sport, budget.plannedMinutes])) }, analysis: plan.analysis, plan };
    } catch (error) {
      outcome = { valid: false, errors: error.issues ?? [{ code: error.category ?? "EVALUATION_ERROR", message: error.message }] };
      if (proposalAttempts && !attempts.some(attempt => attempt.attempt === proposalAttempts)) {
        attempts.push({ attempt: proposalAttempts, status: "NOT_VALIDATED", errors: outcome.errors });
      }
    }
    const tokens = Object.fromEntries(["inputTokens", "cachedInputTokens", "outputTokens", "totalTokens"].map(key =>
      [key, calls.length && calls.every(call => call[key] !== null) ? calls.reduce((sum, call) => sum + call[key], 0) : null]));
    const context = GenerationInputSchema.parse(scenario.input).context;
    const block = context.developmentBlock;
    const strategy = { planningObjective: context.planningObjective.mode, seasonPhase: context.seasonPhase,
      developmentBlock: block ? { weekIndex: block.weekIndex, plannedWeeks: block.plannedWeeks, weekRole: block.weekRole,
        focuses: block.focuses.map(({ sport, capability, role, progressionStrategy }) => ({ sport, capability, role, progressionStrategy })),
      } : null };
    results.push({ id: scenario.id, description: scenario.description, model: calls.at(-1)?.model ?? null,
      proposalAttempts, latencyMs: Date.now() - started, tokens, calls, attempts, strategy, ...outcome });
  }
  return results;
}

// Keep the full JSON on stdout for files/tools; readable telemetry goes to stderr.
export function formatEvaluationSummary(result) {
  const tokenCount = value => value == null ? "unknown" : value.toLocaleString("en-US");
  const responseIds = result.calls.map(call => call.responseId ?? "not returned");
  const block = result.strategy?.developmentBlock;
  const strategyLines = result.strategy ? [
    `Planning objective: ${result.strategy.planningObjective}`,
    `Season phase: ${result.strategy.seasonPhase ?? "none"}`,
    ...(block ? [`Development block: week ${block.weekIndex === null ? "outside block" : block.weekIndex + 1} / ${block.plannedWeeks}`,
      `Role: ${block.weekRole ?? "review needed"}`,
      ...block.focuses.map(focus => `${focus.role}: ${focus.sport} / ${focus.capability}; progression: ${focus.progressionStrategy}`),
    ] : ["Development block: none (no-block weekly planning)"]),
  ] : [];
  const attemptLines = (result.attempts ?? []).flatMap(attempt => [
    `Attempt ${attempt.attempt}: ${attempt.status}`,
    ...attempt.errors.slice(0, 10).map(error => `  ${error.code}${error.workoutId ? ` | workout: ${error.workoutId}` : ""} | path: ${error.path?.join(".") || "response"} | ${error.message}`),
    ...(attempt.errors.length > 10 ? [`  ${attempt.errors.length - 10} more errors; see attempts in JSON output.`] : []),
  ]);
  return [
    `Scenario: ${result.id}`,
    ...strategyLines,
    `Model: ${result.model ?? "none (local / no model response)"}`,
    `Proposal attempts: ${result.proposalAttempts} | Provider calls: ${result.calls.length}`,
    `Latency: ${(result.latencyMs / 1000).toFixed(1)} s (whole scenario)`,
    `OpenAI response IDs (call order): ${responseIds.length ? responseIds.join(", ") : "none"}`,
    `Input tokens: ${tokenCount(result.tokens.inputTokens)}`,
    `Cached input: ${tokenCount(result.tokens.cachedInputTokens)}`,
    `Output tokens: ${tokenCount(result.tokens.outputTokens)}`,
    `Total tokens: ${tokenCount(result.tokens.totalTokens)}`,
    `Validation: ${result.valid ? "PASS" : "FAIL"}`,
    ...attemptLines,
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
