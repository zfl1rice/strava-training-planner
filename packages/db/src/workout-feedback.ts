import { WorkoutFeedbackMutationSchema, WorkoutStatesSchema, calendarWorkouts, validateStoredPlan } from "@pkg/shared";
import { prisma } from "./client.js";
import { lockUserTraining } from "./training-lock.js";
import { PlanningSettingsConflictError, PlanningSettingsNotFoundError } from "./planning-settings.js";

export async function updateWorkoutFeedback(userId: number, input: unknown) {
  const change = WorkoutFeedbackMutationSchema.parse(input);
  return prisma.$transaction(async database => {
    await lockUserTraining(database, userId);
    const row = await database.weeklyPlan.findFirst({ where: { id: change.planId, userId } });
    if (!row) throw new PlanningSettingsNotFoundError("Plan not found.");
    if (row.updatedAt.toISOString() !== change.expectedUpdatedAt) throw new PlanningSettingsConflictError("Plan changed. Reload the calendar before saving feedback.");
    const workout = calendarWorkouts(validateStoredPlan(row.content)).find(value => value.id === change.workoutId);
    if (!workout) throw new PlanningSettingsNotFoundError("Workout not found.");
    const states = WorkoutStatesSchema.parse(row.workoutStates).filter(state => (state.workoutId ?? `${state.date}:${state.templateId}`) !== workout.id);
    states.push({ date: workout.date, templateId: workout.templateId ?? "custom", workoutId: workout.id,
      locked: change.locked, completion: change.completion, feedback: { comment: change.comment, rpe: change.rpe } });
    await database.weeklyPlan.update({ where: { id: row.id }, data: { workoutStates: states, updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)) } });
  });
}
