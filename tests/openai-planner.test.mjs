import assert from "node:assert/strict";
import { test, after } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { easyWorkout, generatePlanWithCorrections, ProposalAttemptsExhaustedError, PlanProviderError, PlanningContextSchema } from "@pkg/shared";
import { prisma, saveWeeklyGoals, generateAndSaveFlexiblePlan, createOrReusePlanRun, executePlanRun } from "@pkg/db";
import { createOpenAIPlanProvider, OPENAI_PLAN_FORMAT } from "../apps/worker/src/openai-planner.ts";
import { readPlannerConfig } from "../apps/worker/src/planner-config.ts";
import { configuredPlanProvider } from "../apps/worker/src/plan-provider.ts";
import { PLANNER_INSTRUCTIONS, buildOpenAIPlanningInput } from "../apps/worker/src/planner-prompt.ts";
import { evaluatePlanner, formatEvaluationSummary } from "../scripts/evaluate-planner.mjs";
import { planningScenarios } from "./fixtures/planning-scenarios.mjs";

if (!/^planner_oauth_test_[a-f0-9]{16}$/.test(process.env.OAUTH_TEST_DATABASE ?? "")) throw new Error("Disposable test database required");
after(async () => prisma.$disconnect());
const input = () => planningScenarios().find(scenario => scenario.id === "normal-build").input;
const config = { provider: "openai", apiKey: "fake-test-key", model: "gpt-5.6-luna", timeoutMs: 2000, maxOutputTokens: 16000 };
const proposal = (date = "2026-09-08") => ({ version: 1, explanation: "A short easy session for this test.", workouts: [easyWorkout("bike", date, "BIKE", 30)] });
const response = (value, overrides = {}) => ({
  id: "resp_test", object: "response", created_at: 0, status: "completed", model: "gpt-5.6-luna",
  output: [{ type: "message", role: "assistant", id: "msg_test", status: "completed", content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }],
  usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 150 }, ...overrides,
});
const jsonResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function mockProvider(handler, overrides = {}) {
  const requests = [];
  // Exercise the real SDK's request serialization, errors, and AbortSignal without a network call.
  const client = new OpenAI({ apiKey: "fake-test-key", maxRetries: 0, fetch: async (url, init) => {
    const body = JSON.parse(init.body); requests.push(body);
    return handler(body, init.signal, requests.length);
  } });
  return { provider: createOpenAIPlanProvider({ ...config, ...overrides }, client), requests };
}
async function userAndRun() {
  const user = await prisma.user.create({ data: {} });
  await saveWeeklyGoals(user.id, { RUN: 120, BIKE: 240, SWIM: 0 });
  const before = await generateAndSaveFlexiblePlan(user.id);
  return { user, before, run: await createOrReusePlanRun(user.id, { scope: "NEXT_WEEK" }) };
}
const proposalForRequest = body => proposal(JSON.parse(body.input[0].content).planning.targetWeek.startDate);
const abortedFetch = signal => new Promise((_, reject) => {
  const abort = () => reject(new DOMException("Aborted", "AbortError"));
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
});

test("planning instructions request contextual goal discipline and a consistent final week", () => {
  // Policy assertions intentionally avoid one exact prompt snapshot or expected AI plan.
  const instructions = PLANNER_INSTRUCTIONS.replace(/\s+/g, " ");
  for (const policy of [
    /Saved goals are immutable/,
    /strong planning targets, not exact mathematical requirements/,
    /Small departures.*acceptable.*coherent workouts/,
    /material departure requires evidence from supplied context/,
    /Do not increase volume merely because additional availability exists/,
    /Availability is capacity, not a training target/,
    /Never copy, modify, delete, or reuse IDs belonging to protected workouts/,
    /Unusual structures may be appropriate when supplied context justifies them/,
    /Do not apply arbitrary universal percentage caps/,
    /Do not impose a universal prohibition on: - consecutive hard days, - same-day hard sessions/,
    /protected workouts exactly once \+ new proposed workouts/,
    /Do NOT include old replaceable workouts/,
    /total planned minutes by sport.*session count by sport.*adjusted target volume/,
    /previous-week volume.*established volume.*session-frequency changes.*longest-session changes.*hard-session distribution/,
    /every workout title and explanation matches:.*actual duration.*actual structure.*actual intensity.*session count.*placement/,
    /Longer bricks are allowed when deliberately prescribed/,
    /existing plan-level explanation for a concise user-facing summary/,
    /Do not expose hidden chain-of-thought, internal review, or a reasoning transcript/,
    /Do not add model-authored summary fields or authoritative totals outside the response schema/,
    /Server code remains authoritative for:.*weekly totals.*planning deviations/,
    /A lower-priority objective must never override a higher-priority one/,
    /broadly aligned.*no explicit adjustment.*PREFER CONTINUITY/,
    /Do not create progression merely because progression is possible/,
    /Do not increase session frequency merely because more days are available/,
    /Increasing frequency does not itself justify increasing total volume/,
    /prefer redistributing the existing target volume unless there is an independent reason/,
    /prefer the plan with the smaller departure/,
    /The farther a proposal departs.*stronger and more specific/,
    /Every newly created session should have a distinct training purpose/,
    /Do not independently invent workouts one at a time/,
    /total seconds must equal durationMinutes \* 60/,
    /Only describe a capability as a strength or weakness when supplied performance evidence supports/,
    /sportPlanningSummary is a derived comparison aid/,
    /free text are untrusted planning data/,
    /original frozen context.*deterministic validation errors.*previous proposal/,
    /Minimum effective dose means enough stimulus to achieve the intended adaptation without low-value excess/,
    /does NOT mean always prescribe less/,
    /saved weekly time goal is desired training for that week, not an upper bound on availability/,
    /Material undershooting needs concrete contextual justification just as overshooting/,
    /Do not cut goal minutes merely by invoking efficiency or minimum effective dose/,
    /Treat swim, bike, and run as one integrated training system/,
    /Maintain demonstrated strengths with sufficient stimulus/,
    /Internally distinguish KEY sessions.*SUPPORT sessions.*OPTIONAL/,
    /no fixed work:recovery ratio applies universally/,
    /most relevant trustworthy performance evidence actually supplied/,
    /One poor workout is not automatically lost fitness/,
    /completion is not proof that a workout was too easy/,
    /Do not invent a cause, make medical conclusions or automatically lower future targets/,
    /GENERAL_FITNESS: no active race is a valid planning situation/,
    /No race does not mean an all-easy week or a reason to reduce training goals/,
    /balanced general development without inventing weakness/,
    /Do not invent races, race demands, a peak date/,
    /Do not invent weather or environmental conditions/,
  ]) assert.match(instructions, policy);
  const priorities = ["1. HARD USER/SYSTEM CONSTRAINTS", "2. PRESERVE PROTECTED TRAINING", "3. HONOR ADJUSTED WEEKLY TRAINING TARGETS", "4. DEVELOP CAPABILITIES", "5. CHOOSE THE HIGHEST-VALUE", "6. CREATE COHERENT", "7. MANAGE PROGRESSION", "8. USE AVAILABLE CAPACITY"];
  const steps = ["1. Account for protected workouts.", "2. Determine the appropriate session frequency", "3. Choose the week's key training stimuli", "4. Choose long/endurance sessions", "5. Allocate remaining easy/supporting training.", "6. Distribute the adjusted weekly target volume", "7. Add structured intensity and interval details.", "8. Review the resulting week as a whole.", "9. Correct inconsistencies before returning the proposal."];
  for (const ordered of [priorities, steps]) {
    const positions = ordered.map(text => PLANNER_INSTRUCTIONS.indexOf(text));
    assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
  }
});

test("planning objective is derived for old snapshots and cannot override their race data", () => {
  const context = input().context;
  delete context.planningObjective;
  assert.equal(PlanningContextSchema.parse(context).planningObjective.mode, "RACE_TARGETED");
  context.planningObjective = { mode: "GENERAL_FITNESS" };
  assert.equal(PlanningContextSchema.parse(context).planningObjective.mode, "RACE_TARGETED");
  context.races[0].goal.date = "2026-09-05";
  context.planningObjective = { mode: "RACE_TARGETED" };
  assert.equal(PlanningContextSchema.parse(context).planningObjective.mode, "GENERAL_FITNESS");
  context.races = [];
  assert.equal(PlanningContextSchema.parse(context).planningObjective.mode, "GENERAL_FITNESS");
});

test("no-race scenario reaches the SDK with explicit general-fitness intent and desired goals", async () => {
  const scenario = planningScenarios().find(value => value.id === "general-fitness");
  const before = structuredClone(scenario.input);
  const mock = mockProvider(() => jsonResponse(response(proposal())));
  const plan = await generatePlanWithCorrections(scenario.input, mock.provider);
  const payload = JSON.parse(mock.requests[0].input[0].content).planning;
  assert.deepEqual(payload.planningObjective, { mode: "GENERAL_FITNESS" });
  assert.deepEqual(payload.races, []); assert.deepEqual(payload.goals, { RUN: 120, BIKE: 240, SWIM: 60 });
  assert.equal(plan.days.filter(day => day.kind === "WORKOUT").length, 1);
  assert.deepEqual(scenario.input, before);
});

test("asymmetric evidence stays dynamic and does not update baselines or infer missing capabilities", () => {
  const scenario = planningScenarios().find(value => value.id === "asymmetric-evidence");
  const before = structuredClone(scenario.input);
  const payload = buildOpenAIPlanningInput(scenario.input);
  assert.equal(payload.planningObjective.mode, "RACE_TARGETED");
  assert.equal(payload.performanceProfile.cycling[0].score, 85);
  assert.equal(payload.performanceProfile.running[0].score, 45);
  assert.deepEqual(payload.performanceProfile.swimming, []);
  assert.equal(payload.performanceProfile.evidence.length, 2);
  assert.equal(payload.fitness.effective.cycling.value, 250);
  assert.equal(payload.fitness.runningThresholdPace, null);
  assert.deepEqual(scenario.input, before);
  assert.ok(!PLANNER_INSTRUCTIONS.includes("synthetic-assessment-v1"));
});

test("pending snapshots without planningObjective can retry without false staleness", async () => {
  const { run } = await userAndRun();
  await assert.rejects(executePlanRun(run.id, () => { throw new Error("Synthetic interruption"); }), /retrying/);
  const saved = await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } });
  delete saved.planRequest.snapshot.context.planningObjective;
  await prisma.jobRun.update({ where: { id: run.id }, data: { planRequest: saved.planRequest, nextRetryAt: null } });
  assert.equal((await executePlanRun(run.id)).status, "SUCCESS");
});

test("per-sport summary aligns goals, previous week and established training", () => {
  const original = input(); const before = structuredClone(original);
  const summary = buildOpenAIPlanningInput(original).sportPlanningSummary;
  assert.deepEqual(summary.RUN, { savedGoalMinutes: 120, adjustedTargetMinutes: 120,
    protectedMinutes: 0, protectedSessions: 0, previousWeekMinutes: 120, previousWeekSessions: 2, previousWeekLongestMinutes: 60,
    establishedMinutes: 120, establishedSessions: 2, establishedLongestMinutes: 60, establishedSampleWeeks: 3 });
  assert.equal(summary.BIKE.establishedMinutes, 240); assert.equal(summary.SWIM.establishedMinutes, 60);
  assert.deepEqual(original, before);
});

test("per-sport summary separates adjustments and protected work from saved targets", () => {
  const original = input();
  original.context.adjustments = [{ id: "reduced", sport: "RUN", startDate: original.fromDate,
    endDate: "2026-09-13", volumePercent: 50, intensityPercent: 100, comment: "Temporary reduction" }];
  original.protectedWorkouts = [easyWorkout("keep", "2026-09-08", "RUN", 75)];
  const before = structuredClone(original);
  const summary = buildOpenAIPlanningInput(original).sportPlanningSummary.RUN;
  assert.equal(summary.savedGoalMinutes, 120); assert.equal(summary.adjustedTargetMinutes, 60);
  assert.equal(summary.protectedMinutes, 75); assert.equal(summary.protectedSessions, 1);
  assert.equal(summary.previousWeekMinutes, 120);
  assert.deepEqual(original, before);
});

test("established comparisons share the report definition and preserve sparse or missing evidence", async () => {
  const original = input();
  const weeks = original.context.trainingHistory.weeks;
  for (const week of weeks) week.sports.RUN = { minutes: 0, sessions: 0, longestMinutes: 0, completedPlanSessions: 0, completedPlanHardSessions: 0 };
  let summary = buildOpenAIPlanningInput(original).sportPlanningSummary.RUN;
  assert.equal(summary.previousWeekMinutes, 0); assert.equal(summary.previousWeekSessions, 0);
  assert.equal(summary.establishedMinutes, null); assert.equal(summary.establishedSampleWeeks, 0);
  const observations = [[300, 2, 160], [240, 4, 90], [120, 6, 80], [60, 30, 60]];
  observations.forEach(([minutes, sessions, longestMinutes], index) => Object.assign(weeks[index].sports.RUN, { minutes, sessions, longestMinutes }));
  summary = buildOpenAIPlanningInput(original).sportPlanningSummary.RUN;
  assert.equal(summary.establishedMinutes, 240); assert.equal(summary.establishedSessions, 4);
  assert.equal(summary.establishedLongestMinutes, 90); assert.equal(summary.establishedSampleWeeks, 3);
  const plan = await generatePlanWithCorrections(original);
  const deviation = plan.analysis.deviations.find(value => value.type === "VOLUME_DECREASE" && value.sport === "RUN");
  assert.equal(deviation.measurements.recentEstablishedMinutes, summary.establishedMinutes);
  assert.equal(deviation.measurements.establishedSampleWeeks, summary.establishedSampleWeeks);
  for (const week of weeks.slice(2)) Object.assign(week.sports.RUN, { minutes: 0, sessions: 0, longestMinutes: 0 });
  summary = buildOpenAIPlanningInput(original).sportPlanningSummary.RUN;
  assert.equal(summary.establishedMinutes, 270); assert.equal(summary.establishedSessions, 3);
  assert.equal(summary.establishedLongestMinutes, 125); assert.equal(summary.establishedSampleWeeks, 2);
  delete original.context.trainingHistory;
  summary = buildOpenAIPlanningInput(original).sportPlanningSummary.RUN;
  assert.equal(summary.previousWeekMinutes, 120); assert.equal(summary.previousWeekSessions, 2);
  assert.equal(summary.previousWeekLongestMinutes, null); assert.equal(summary.establishedMinutes, null);
  assert.equal(summary.establishedSessions, null); assert.equal(summary.establishedLongestMinutes, null);
});

test("prompt construction preserves goals, protected workouts and the evidence for final-week review", () => {
  const original = planningScenarios().find(scenario => scenario.id === "locked-remainder").input;
  const before = structuredClone(original);
  const planning = buildOpenAIPlanningInput(original);
  assert.deepEqual(original, before);
  assert.deepEqual(planning.goals, original.context.goals);
  assert.deepEqual(planning.trainingHistory, original.context.trainingHistory);
  assert.deepEqual(planning.recentTraining, original.context.recentTraining);
  assert.ok(original.protectedWorkouts.length > 0);
  assert.equal(planning.protectedWorkouts.length, original.protectedWorkouts.length);
  for (const workout of original.protectedWorkouts) {
    const compact = planning.protectedWorkouts.find(value => value.id === workout.id);
    assert.equal(compact.durationMinutes, workout.durationMinutes);
    assert.equal(compact.date, workout.date);
    assert.equal(compact.sport, workout.sport);
  }
});

test("a material soft goal deviation still passes without a new quality rejection loop", async () => {
  const candidate = { version: 1, explanation: "Synthetic material deviation to verify the soft validation boundary.",
    workouts: ["2026-09-08", "2026-09-10", "2026-09-13"].map((date, index) => easyWorkout(`run-${index}`, date, "RUN", 60)) };
  const mock = mockProvider(() => jsonResponse(response(candidate)));
  const plan = await generatePlanWithCorrections(input(), mock.provider);
  assert.equal(mock.requests.length, 1);
  assert.equal(plan.goals.RUN, 120); assert.equal(plan.budgets.RUN.plannedMinutes, 180);
  assert.ok(plan.analysis.deviations.some(value => value.type === "GOAL_DIFFERENCE" && value.sport === "RUN" && value.measurements.differenceMinutes === 60));
});

test("evaluator summary exposes aggregated usage and ordered response IDs, including unknown failures", async () => {
  const invalid = proposal(); invalid.workouts[0].durationMinutes = 31;
  const mock = mockProvider((_, __, count) => jsonResponse(response(count === 1 ? invalid : proposal(), { id: `resp_${count}` })));
  const scenarios = [{ id: "normal-build", description: "Mock telemetry", input: input() }];
  const [result] = await evaluatePlanner(mock.provider, scenarios);
  const summary = formatEvaluationSummary(result);
  assert.equal(result.valid, true);
  for (const expected of ["Scenario: normal-build", `Model: ${config.model}`, "Proposal attempts: 2 | Provider calls: 2",
    "OpenAI response IDs (call order): resp_1, resp_2", "Input tokens: 200", "Cached input: 40", "Output tokens: 100", "Total tokens: 300", "Validation: PASS"]) assert.ok(summary.includes(expected), expected);
  assert.match(summary, /Latency: \d+\.\d s/);
  assert.ok(!summary.includes("fake-test-key")); assert.ok(!summary.includes("workouts"));

  const failed = mockProvider(() => jsonResponse(response(null, { id: "resp_incomplete", status: "incomplete", usage: null })));
  const [failure] = await evaluatePlanner(failed.provider, scenarios);
  const failureSummary = formatEvaluationSummary(failure);
  assert.match(failureSummary, /Validation: FAIL/);
  assert.match(failureSummary, /resp_incomplete/);
  for (const label of ["Input tokens", "Cached input", "Output tokens", "Total tokens"]) assert.ok(failureSummary.includes(`${label}: unknown`));
});

test("CLI prints a readable summary separately from parseable JSON and stays local without --openai", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/evaluate-planner.mjs", import.meta.url)), "--scenario", "normal-build"], {
    env: { ...process.env, PLANNER_PROVIDER: "openai", OPENAI_API_KEY: "" }, encoding: "utf8", timeout: 15000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const [evaluation] = JSON.parse(result.stdout);
  assert.equal(evaluation.valid, true); assert.equal(evaluation.calls.length, 0);
  assert.match(result.stderr, /Scenario: normal-build/);
  assert.match(result.stderr, /Provider calls: 0/);
  assert.match(result.stderr, /Validation: PASS/);
});

test("valid structured response uses the official SDK, private compact input, and token metadata", async () => {
  const calls = [];
  const mock = mockProvider(() => jsonResponse(response(proposal())));
  const plan = await generatePlanWithCorrections(input(), mock.provider, { reportCall: async call => { calls.push(call); } });
  assert.equal(plan.totalMinutes, 30);
  assert.equal(mock.requests.length, 1);
  const body = mock.requests[0];
  assert.equal(body.store, false); assert.equal(body.model, config.model);
  assert.equal(body.text.format.type, "json_schema"); assert.equal(body.text.format.strict, true);
  assert.deepEqual(body.text.format, JSON.parse(JSON.stringify(OPENAI_PLAN_FORMAT)));
  assert.ok(!JSON.stringify(body.text.format).includes('"resolved"'));
  const context = JSON.parse(body.input[0].content);
  assert.equal(context.correction, null);
  assert.equal(context.planning.athlete, undefined);
  assert.ok(!JSON.stringify(body).includes("fake-test-key"));
  assert.match(body.instructions, /immutable/);
  assert.equal(calls[0].category, "RESPONSE"); assert.equal(calls[0].responseId, "resp_test");
  assert.equal(calls[0].inputTokens, 100); assert.equal(calls[0].cachedInputTokens, 20);
  assert.equal(calls[0].outputTokens, 50); assert.equal(calls[0].totalTokens, 150);
  assert.ok(calls[0].latencyMs >= 0);
});

test("domain-invalid first proposal is corrected with errors and original context", async () => {
  const invalid = proposal(); invalid.workouts[0].durationMinutes = 31;
  const mock = mockProvider((_, __, count) => jsonResponse(response(count === 1 ? invalid : proposal())));
  assert.equal((await generatePlanWithCorrections(input(), mock.provider)).totalMinutes, 30);
  assert.equal(mock.requests.length, 2);
  const [first, second] = mock.requests.map(body => JSON.parse(body.input[0].content));
  assert.deepEqual(second.planning, first.planning);
  assert.equal(second.correction.attempt, 2);
  assert.deepEqual(second.correction.previousProposal, invalid);
  assert.ok(second.correction.errors.some(issue => issue.code === "SCHEMA" && Array.isArray(issue.path)));
});

test("three invalid or malformed responses exhaust only the proposal loop", async () => {
  for (const value of [{}, null]) {
    const calls = [];
    const mock = mockProvider(() => {
      const reply = response(value);
      if (value === null) reply.output[0].content[0].text = "not JSON";
      return jsonResponse(reply);
    });
    await assert.rejects(generatePlanWithCorrections(input(), mock.provider, { reportCall: async call => { calls.push(call); } }), ProposalAttemptsExhaustedError);
    assert.equal(mock.requests.length, 3);
    assert.deepEqual(calls.map(call => call.proposalAttempt), [1, 2, 3]);
    assert.ok(calls.every(call => call.category === "MALFORMED"));
  }
});

test("timeout aborts the SDK request and is an infrastructure failure", async () => {
  const calls = [];
  const mock = mockProvider((_, signal) => abortedFetch(signal), { timeoutMs: 30 });
  await assert.rejects(generatePlanWithCorrections(input(), mock.provider, { reportCall: async call => { calls.push(call); } }), error => error instanceof PlanProviderError && error.category === "TIMEOUT" && error.retryable);
  assert.equal(mock.requests.length, 1); assert.equal(calls[0].category, "TIMEOUT");
});

test("network, server and rate-limit errors do not activate hidden SDK retries", async () => {
  for (const status of [0, 500, 429]) {
    const mock = mockProvider(() => {
      if (!status) throw new TypeError("Synthetic network failure");
      return jsonResponse({ error: { message: "Must not leak raw provider text", type: "test_error" } }, status, { "retry-after": "7" });
    });
    await assert.rejects(generatePlanWithCorrections(input(), mock.provider), error => {
      assert.equal(error.category, "TRANSIENT"); assert.equal(error.retryable, true);
      assert.ok(!error.message.includes("Must not leak"));
      if (status) assert.equal(error.retryAfterMs, 7000);
      return true;
    });
    assert.equal(mock.requests.length, 1);
  }
});

test("refusal, incomplete response, and authentication failure are terminal", async () => {
  const cases = [
    ["REFUSAL", () => jsonResponse(response(null, { output: [{ type: "message", content: [{ type: "refusal", refusal: "No" }] }] }))],
    ["INCOMPLETE", () => jsonResponse(response(null, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }))],
    ["CONFIGURATION", () => jsonResponse({ error: { message: "secret raw diagnostic" } }, 401)],
    ["PROVIDER_ERROR", () => jsonResponse(response(null, { status: "failed", error: { code: "invalid_prompt", message: "bad" } }))],
  ];
  for (const [category, handler] of cases) {
    const mock = mockProvider(handler);
    await assert.rejects(generatePlanWithCorrections(input(), mock.provider), error => error.category === category && !error.retryable);
    assert.equal(mock.requests.length, 1);
  }
});

test("missing usage stays unknown; missing message enters correction", async () => {
  const calls = [];
  const mock = mockProvider((_, __, count) => jsonResponse(response(proposal(), { usage: null, ...(count === 1 ? { output: [] } : {}) })));
  await generatePlanWithCorrections(input(), mock.provider, { reportCall: async call => { calls.push(call); } });
  assert.equal(calls.length, 2); assert.equal(calls[0].category, "MALFORMED");
  assert.equal(calls[1].totalTokens, null);
});

test("configuration defaults to deterministic; OpenAI without a key fails the job safely", async () => {
  assert.equal(readPlannerConfig({}).provider, "deterministic");
  assert.throws(() => readPlannerConfig({ PLANNER_PROVIDER: "openai" }), /OPENAI_API_KEY/);
  assert.throws(() => readPlannerConfig({ PLANNER_PROVIDER: "openai", OPENAI_API_KEY: "fake", OPENAI_PLANNER_TIMEOUT_MS: "120000" }), /TIMEOUT/);
  assert.ok((await generatePlanWithCorrections(input(), configuredPlanProvider())).totalMinutes > 0);
  const { run, before } = await userAndRun();
  const previous = process.env.PLANNER_PROVIDER;
  process.env.PLANNER_PROVIDER = "openai";
  try { assert.equal((await executePlanRun(run.id, configuredPlanProvider())).status, "FAILED"); }
  finally { process.env.PLANNER_PROVIDER = previous; }
  assert.deepEqual((await prisma.weeklyPlan.findUniqueOrThrow({ where: { id: before.id } })).content, before.content);
});

test("AI failure preserves the installed plan and persists safe call metadata", async () => {
  const { run, before } = await userAndRun();
  const mock = mockProvider(() => jsonResponse(response(null, { status: "incomplete" })));
  assert.equal((await executePlanRun(run.id, mock.provider)).status, "FAILED");
  assert.equal((await executePlanRun(run.id, mock.provider)).status, "FAILED");
  assert.equal(mock.requests.length, 1);
  const persisted = await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(persisted.planRequest.providerExecution.calls[0].category, "INCOMPLETE");
  assert.equal(persisted.planRequest.providerExecution.calls[0].infrastructureAttempt, 1);
  assert.deepEqual((await prisma.weeklyPlan.findUniqueOrThrow({ where: { id: before.id } })).content, before.content);
});

test("infrastructure retry uses the frozen input and coherent proposal numbering", async () => {
  const { run } = await userAndRun();
  const mock = mockProvider((body, _, count) => count === 1 ? jsonResponse({ error: { message: "Unavailable" } }, 500) : jsonResponse(response(proposalForRequest(body))));
  await assert.rejects(executePlanRun(run.id, mock.provider), /retrying/);
  await prisma.jobRun.update({ where: { id: run.id }, data: { nextRetryAt: null } });
  assert.equal((await executePlanRun(run.id, mock.provider)).status, "SUCCESS");
  assert.deepEqual(mock.requests[0], mock.requests[1]);
  const persisted = await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.deepEqual(persisted.planRequest.providerExecution.calls.map(call => [call.infrastructureAttempt, call.proposalAttempt]), [[1, 1], [2, 1]]);
});

test("durably recorded response is reused after atomic save failure and duplicate delivery", async () => {
  const { user, run, before } = await userAndRun();
  const mock = mockProvider(body => jsonResponse(response(proposalForRequest(body))));
  assert.ok(Number.isSafeInteger(run.id));
  await prisma.$executeRawUnsafe(`CREATE FUNCTION reject_ai_success() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = ${run.id} AND NEW.status = 'SUCCESS' THEN RAISE EXCEPTION 'Injected save failure'; END IF; RETURN NEW; END $$`);
  try {
    await prisma.$executeRawUnsafe('CREATE TRIGGER reject_ai_success BEFORE UPDATE ON "JobRun" FOR EACH ROW EXECUTE FUNCTION reject_ai_success()');
    await assert.rejects(executePlanRun(run.id, mock.provider), /retrying/);
    assert.deepEqual((await prisma.weeklyPlan.findUniqueOrThrow({ where: { id: before.id } })).content, before.content);
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS reject_ai_success ON "JobRun"');
    await prisma.$executeRawUnsafe('DROP FUNCTION reject_ai_success()');
  }
  await prisma.jobRun.update({ where: { id: run.id }, data: { nextRetryAt: null } });
  assert.equal((await executePlanRun(run.id, mock.provider)).status, "SUCCESS");
  assert.equal((await executePlanRun(run.id, mock.provider)).status, "SUCCESS");
  assert.equal(mock.requests.length, 1);
  const plan = await prisma.weeklyPlan.findFirstOrThrow({ where: { userId: user.id } });
  assert.deepEqual(plan.content.generation, { provider: "openai", model: config.model, responseId: "resp_test", jobRunId: run.id });
});

test("heartbeat renews ownership while the provider is pending; duplicate execution defers", async () => {
  const { run } = await userAndRun(); const entered = deferred(), release = deferred();
  const mock = mockProvider(async body => { entered.resolve(); await release.promise; return jsonResponse(response(proposalForRequest(body))); });
  const running = executePlanRun(run.id, mock.provider, { heartbeatIntervalMs: 25 });
  try {
    await entered.promise;
    const shortLease = new Date(Date.now() + 2000);
    await prisma.jobRun.update({ where: { id: run.id }, data: { leaseExpiresAt: shortLease } });
    let renewed = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 25));
      const row = await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } });
      if (row.leaseExpiresAt > shortLease) { renewed = true; break; }
    }
    assert.equal(renewed, true);
    assert.equal((await executePlanRun(run.id, mock.provider)).status, "DEFERRED");
  } finally { release.resolve(); }
  assert.equal((await running).status, "SUCCESS"); assert.equal(mock.requests.length, 1);
});

test("superseding a request aborts its SDK call and leaves the newer plan authoritative", async () => {
  const { user, run } = await userAndRun(); const entered = deferred();
  const mock = mockProvider((_, signal) => { entered.resolve(); return abortedFetch(signal); });
  const running = executePlanRun(run.id, mock.provider, { heartbeatIntervalMs: 25 });
  await entered.promise;
  await saveWeeklyGoals(user.id, { RUN: 180, BIKE: 300, SWIM: 0 });
  const newer = await createOrReusePlanRun(user.id, { scope: "NEXT_WEEK" });
  assert.notEqual(newer.id, run.id);
  assert.equal((await executePlanRun(newer.id)).status, "SUCCESS");
  const plan = await prisma.weeklyPlan.findFirstOrThrow({ where: { userId: user.id } });
  assert.equal((await running).status, "CANCELLED");
  assert.deepEqual(await prisma.weeklyPlan.findUniqueOrThrow({ where: { id: plan.id } }), plan);
  const row = await prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } });
  assert.equal(row.planRequest.providerExecution.calls[0].category, "CANCELLED");
});
