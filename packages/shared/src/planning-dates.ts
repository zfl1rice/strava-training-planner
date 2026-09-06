import { z } from "zod";

export const PlanningTimestampSchema = z.string().datetime();

// Date-only values are calendar labels, never instants in the server's timezone.
export const LocalDateSchema = z.string().regex(/^(19|20|21)\d{2}-\d{2}-\d{2}$/).refine(value => {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}, "Invalid calendar date");

export const TimeZoneSchema = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; }
  catch { return false; }
}, "Unknown timezone");

export function localDateAt(instant: Date, timeZone: string): string {
  TimeZoneSchema.parse(timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => parts.find(value => value.type === type)!.value;
  return LocalDateSchema.parse(`${part("year")}-${part("month")}-${part("day")}`);
}

export function addCalendarDays(date: string, days: number): string {
  LocalDateSchema.parse(date);
  return LocalDateSchema.parse(new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10));
}

export function calendarWeekday(date: string): number {
  LocalDateSchema.parse(date);
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

export function calendarMonday(date: string): string {
  return addCalendarDays(date, -calendarWeekday(date));
}
