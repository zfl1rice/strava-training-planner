import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { FlexiblePlanSchema, calendarWorkouts, generateWeeklyPlan, summarizeTraining, validateStoredPlan } from "@pkg/shared";
import { prisma, getTrainingCalendar, buildPlanningContext } from "@pkg/db";

assert.match(process.env.OAUTH_TEST_DATABASE ?? "", /^planner_oauth_test_[a-f0-9]{16}$/);
assert.equal(new URL(process.env.DATABASE_URL).pathname, `/${process.env.OAUTH_TEST_DATABASE}`);
let user;
const now = new Date("2026-09-06T12:00:00Z");
beforeEach(async () => { user = await prisma.user.create({ data: {} }); });
after(async () => { await prisma.$disconnect(); });

function customPlan() {
  const old = generateWeeklyPlan(summarizeTraining([], now));
  const workout = (id, date) => ({ kind: "WORKOUT", id, date, templateId: null, sport: "BIKE", title: "Short intervals",
    effort: "HARD", optional: false, explanation: "Custom two-minute efforts", durationMinutes: 12,
    blocks: [{ repeat: 3, segments: [
      { label: "Work", seconds: 120, instructions: "Ride steadily", target: { metric: "FTP_PERCENT", lower: 100, upper: 110 } },
      { label: "Recover", seconds: 120, instructions: "Pedal gently", target: { metric: "RPE", lower: 2, upper: 3 } },
    ] }],
  });
  return { ...old, version: 2, days: old.days.map(day => ({ kind: "REST", date: day.date, title: "Rest day", durationMinutes: 0 }))
    .flatMap((day, index) => index === 1 ? [workout("a", day.date), workout("b", day.date)] : [day]),
    totalMinutes: 24, budgets: { ...old.budgets, RUN: { ...old.budgets.RUN, plannedMinutes: 0 },
      SWIM: { ...old.budgets.SWIM, plannedMinutes: 0 }, BIKE: { ...old.budgets.BIKE, plannedMinutes: 24, targetMinutes: 30 } } };
}

test("custom repeat blocks and multiple workouts survive storage, calendar, and context reads", async () => {
  const plan = FlexiblePlanSchema.parse(customPlan());
  await prisma.weeklyPlan.create({ data: { userId: user.id, weekStart: new Date(plan.weekStart), content: plan } });
  const calendar = await getTrainingCalendar(user.id, "2026-09");
  assert.deepEqual(calendar.plans[0].content, plan);
  assert.equal(calendarWorkouts(plan).length, 2);
  assert.equal(calendarWorkouts(plan)[0].steps.length, 6);
  assert.equal((await buildPlanningContext(user.id, { now })).existingPlans[0].content.version, 2);
});

test("structured plans reject invalid durations, duplicate IDs, wrong dates and target sports", () => {
  for (const mutate of [
    p => { p.days[1].durationMinutes = 99; }, p => { p.days[2].id = "a"; },
    p => { p.days[1].date = "2026-09-30"; }, p => { p.days[1].sport = "RUN"; },
    p => { p.days[1].blocks[0].repeat = 10000; },
  ]) { const plan = customPlan(); mutate(plan); assert.equal(FlexiblePlanSchema.safeParse(plan).success, false); }
  const legacy = generateWeeklyPlan(summarizeTraining([], now));
  assert.deepEqual(validateStoredPlan(legacy), legacy);
});
