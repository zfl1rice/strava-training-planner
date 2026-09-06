import { NextRequest, NextResponse } from "next/server";
import { getTrainingCalendar } from "@pkg/db";
import { CalendarMonthSchema } from "@pkg/shared";
import { SESSION_COOKIE, userFromSession } from "@/lib/strava-auth";

export const runtime = "nodejs";
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
