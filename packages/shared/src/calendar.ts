import { z } from "zod";
import { mondayUtc } from "./training.js";
import type { SavedWeeklyPlan } from "./planner.js";
import type { SyncDashboard } from "./stravaSchemas.js";

export const CalendarMonthSchema = z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/);

export type TrainingCalendarData = {
  month: string;
  timeZone?: string;
  activities: SyncDashboard["activities"];
  plans: SavedWeeklyPlan[];
};

// Include the complete Monday–Sunday weeks touching the requested month.
export function calendarMonthRange(month: string) {
  CalendarMonthSchema.parse(month);
  const firstDay = new Date(`${month}-01T00:00:00Z`);
  const nextMonth = new Date(firstDay);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const start = mondayUtc(firstDay);
  const end = mondayUtc(nextMonth);
  if (end.getTime() < nextMonth.getTime()) end.setUTCDate(end.getUTCDate() + 7);
  return { start, end };
}
