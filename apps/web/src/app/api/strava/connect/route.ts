import { NextRequest, NextResponse } from "next/server";
import { createOAuthState } from "@pkg/db";
import {
  authCookieOptions, getStravaConfig, hashToken, newOpaqueToken, STATE_COOKIE, STATE_SECONDS,
} from "@/lib/strava-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let config;
  try {
    config = getStravaConfig();
  } catch {
    return NextResponse.redirect(new URL("/?strava=config_error", request.url), 303);
  }
  if (request.headers.get("origin") !== config.callbackUrl.origin) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }
  const state = newOpaqueToken();
  try {
    await createOAuthState(hashToken(state), new Date(Date.now() + STATE_SECONDS * 1000));
  } catch {
    return NextResponse.redirect(new URL("/?strava=storage_error", config.callbackUrl), 303);
  }
  const authorizeUrl = new URL("https://www.strava.com/oauth/authorize");
  authorizeUrl.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.callbackUrl.toString(),
    response_type: "code",
    approval_prompt: "force",
    scope: "read,activity:read_all",
    state,
  }).toString();
  const response = NextResponse.redirect(authorizeUrl, 303);
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(STATE_COOKIE, state, authCookieOptions(config.callbackUrl, STATE_SECONDS));
  return response;
}