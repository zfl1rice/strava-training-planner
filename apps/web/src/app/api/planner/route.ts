import { NextRequest, NextResponse } from "next/server";
import { generateAndSaveFlexiblePlan, getPlannerState, saveWeeklyGoals, PlanSyncInProgressError, PlanHasProtectedWorkoutsError } from "@pkg/db";
import { WeeklyGoalsSchema, GenerationRequestSchema } from "@pkg/shared";
import { getStravaConfig, SESSION_COOKIE, userFromSession } from "@/lib/strava-auth";

export const runtime = "nodejs";
const json = (body: unknown, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "no-store" },
});

export async function GET(request: NextRequest) {
  try {
    const user = await userFromSession(request.cookies.get(SESSION_COOKIE)?.value);
    if (!user) return json({ error: "Connect Strava first" }, 401);
    return json(await getPlannerState(user.id));
  } catch {
    return json({ error: "Could not load your weekly plan. Please try again." }, 503);
  }
}

export async function POST(request: NextRequest) {
  try {
    if (request.headers.get("origin") !== getStravaConfig().callbackUrl.origin) {
      return json({ error: "Invalid request origin" }, 403);
    }
    const user = await userFromSession(request.cookies.get(SESSION_COOKIE)?.value);
    if (!user) return json({ error: "Connect Strava first" }, 401);
    // Client-supplied user IDs, budgets, dates, and workouts are never trusted.
    const raw = await request.text();
    const parsed = GenerationRequestSchema.safeParse(raw ? JSON.parse(raw) : {});
    if (!parsed.success) return json({ error: "Choose next week or the remaining week." }, 400);
    await generateAndSaveFlexiblePlan(user.id, new Date(), parsed.data.scope);
    return json(await getPlannerState(user.id));
  } catch (error) {
    if (error instanceof PlanSyncInProgressError || error instanceof PlanHasProtectedWorkoutsError) return json({ error: error.message }, 409);
    return json({ error: "Could not generate your weekly plan. Please try again." }, 503);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    if (request.headers.get("origin") !== getStravaConfig().callbackUrl.origin) {
      return json({ error: "Invalid request origin" }, 403);
    }
    const user = await userFromSession(request.cookies.get(SESSION_COOKIE)?.value);
    if (!user) return json({ error: "Connect Strava first" }, 401);
    const parsed = WeeklyGoalsSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: "Provide RUN, BIKE, and SWIM minutes as null (automatic) or whole multiples of 5 from 0 to 10080." }, 400);
    const goals = await saveWeeklyGoals(user.id, parsed.data);
    return json({ goals });
  } catch {
    return json({ error: "Could not save your weekly goals. Please try again." }, 503);
  }
}
