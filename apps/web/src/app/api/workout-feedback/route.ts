import { NextRequest, NextResponse } from "next/server";
import { getStravaConfig, SESSION_COOKIE, userFromSession } from "@/lib/strava-auth";
import { updateWorkoutFeedback, PlanningSettingsConflictError, PlanningSettingsNotFoundError } from "@pkg/db";
import { WorkoutFeedbackMutationSchema } from "@pkg/shared";

export const runtime = "nodejs";
export async function PATCH(request: NextRequest) {
  const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  try {
    if (request.headers.get("origin") !== getStravaConfig().callbackUrl.origin) return json({ error: "Invalid request origin" }, 403);
    const user = await userFromSession(request.cookies.get(SESSION_COOKIE)?.value);
    if (!user) return json({ error: "Connect Strava first" }, 401);
    const parsed = WorkoutFeedbackMutationSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: "Check your workout feedback." }, 400);
    await updateWorkoutFeedback(user.id, parsed.data);
    return json({ saved: true });
  } catch (error) {
    if (error instanceof PlanningSettingsConflictError) return json({ error: error.message }, 409);
    if (error instanceof PlanningSettingsNotFoundError) return json({ error: error.message }, 404);
    return json({ error: "Could not save feedback. Reload and try again." }, 503);
  }
}
