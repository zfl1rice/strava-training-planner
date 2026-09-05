import { NextRequest, NextResponse } from "next/server";
import { getStravaConnectionStatus, getValidStravaAccessToken } from "@pkg/db";
import { refreshStravaTokens, StravaTokenError } from "@pkg/shared/strava";
import { getStravaConfig, SESSION_COOKIE, userFromSession } from "@/lib/strava-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const json = (body: unknown, status = 200) => NextResponse.json(body, {
    status, headers: { "Cache-Control": "no-store" },
  });
  let origin;
  try {
    origin = getStravaConfig().callbackUrl.origin;
  } catch {
    return json({ error: "Strava is not configured" }, 503);
  }
  if (request.headers.get("origin") !== origin) return json({ error: "Invalid request origin" }, 403);
  try {
    const user = await userFromSession(request.cookies.get(SESSION_COOKIE)?.value);
    if (!user) return json({ error: "Connect Strava first" }, 401);
    await getValidStravaAccessToken(user.id, refreshStravaTokens);
    const connection = await getStravaConnectionStatus(user.id);
    // Never return access/refresh tokens to the browser.
    return json({ ok: true, connection });
  } catch (error) {
    if (error instanceof StravaTokenError && [400, 401].includes(error.status)) {
      return json({ error: "Please reconnect Strava", reconnectRequired: true }, 401);
    }
    return json({ error: "Unable to check Strava connection. Try again shortly." }, 503);
  }
}