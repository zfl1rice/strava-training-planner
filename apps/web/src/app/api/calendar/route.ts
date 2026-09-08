import { NextRequest, NextResponse } from "next/server";
import { getTrainingCalendar, clearPlannedWeek, TrainingBusyError } from "@pkg/db";
import { CalendarMonthSchema, ClearWeekRequestSchema } from "@pkg/shared";
import { getStravaConfig, SESSION_COOKIE, userFromSession } from "@/lib/strava-auth";

export const runtime = "nodejs";
export async function DELETE(request: NextRequest) {
  try {
    if (request.headers.get("origin") !== getStravaConfig().callbackUrl.origin) return json({ error: "Invalid request origin" }, 403);
    const user = await userFromSession(request.cookies.get(SESSION_COOKIE)?.value);
    if (!user) return json({ error: "Connect Strava first" }, 401);
    const parsed = ClearWeekRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: "Reload the calendar and select a saved week." }, 400);
    return json(await clearPlannedWeek(user.id, parsed.data));
  } catch (error) {
    if (error instanceof TrainingBusyError) return json({ error: error.message }, 409);
    return json({ error: "Could not clear this week. Please reload and try again." }, 503);
  }
}
const json = (body: unknown, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "no-store" },
});

export async function GET(request: NextRequest) {
  try {
    const user = await userFromSession(request.cookies.get(SESSION_COOKIE)?.value);
    if (!user) return json({ error: "Connect Strava first" }, 401);
    const month = CalendarMonthSchema.safeParse(request.nextUrl.searchParams.get("month"));
    if (!month.success) return json({ error: "Choose a month between 1900-01 and 2199-12." }, 400);
    return json(await getTrainingCalendar(user.id, month.data));
  } catch {
    return json({ error: "Could not load your calendar. Please try again." }, 503);
  }
}
