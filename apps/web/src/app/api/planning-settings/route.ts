import { NextRequest, NextResponse } from "next/server";
import { getPlanningSettings, updatePlanningSettings, PlanningSettingsConflictError, PlanningSettingsInputError, PlanningSettingsNotFoundError } from "@pkg/db";
import { PlanningSettingsMutationSchema } from "@pkg/shared";
import { getStravaConfig, SESSION_COOKIE, userFromSession } from "@/lib/strava-auth";

export const runtime = "nodejs";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request: NextRequest) {
  try {
    const user = await userFromSession(request.cookies.get(SESSION_COOKIE)?.value);
    if (!user) return json({ error: "Connect Strava to edit your training settings." }, 401);
    return json(await getPlanningSettings(user.id));
  } catch { return json({ error: "Could not load your settings. Please try again." }, 503); }
}

export async function PATCH(request: NextRequest) {
  try {
    if (request.headers.get("origin") !== getStravaConfig().callbackUrl.origin) return json({ error: "Invalid request origin" }, 403);
    const user = await userFromSession(request.cookies.get(SESSION_COOKIE)?.value);
    if (!user) return json({ error: "Connect Strava to edit your training settings." }, 401);
    const parsed = PlanningSettingsMutationSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? "Check your settings." }, 400);
    return json(await updatePlanningSettings(user.id, parsed.data));
  } catch (error) {
    if (error instanceof PlanningSettingsConflictError) return json({ error: error.message }, 409);
    if (error instanceof PlanningSettingsNotFoundError) return json({ error: error.message }, 404);
    if (error instanceof PlanningSettingsInputError) return json({ error: error.message }, 400);
    return json({ error: "Could not save your settings. Please try again." }, 503);
  }
}
