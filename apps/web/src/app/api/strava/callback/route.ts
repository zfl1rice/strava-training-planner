import { NextRequest, NextResponse } from "next/server";
import { consumeOAuthState, saveStravaAuthorization } from "@pkg/db";
import { parseStravaScopes } from "@pkg/shared";
import { exchangeStravaCode } from "@pkg/shared/strava";
import {
  authCookieOptions, getStravaConfig, hashToken, newOpaqueToken, SESSION_COOKIE,
  SESSION_SECONDS, STATE_COOKIE, statesMatch, validOpaqueToken,
} from "@/lib/strava-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  let callbackUrl: URL;
  try {
    callbackUrl = getStravaConfig().callbackUrl;
  } catch {
    return NextResponse.redirect(new URL("/?strava=config_error", request.url), 303);
  }
  function result(status: string) {
    const response = NextResponse.redirect(new URL(`/?strava=${status}`, callbackUrl), 303);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.cookies.set(STATE_COOKIE, "", authCookieOptions(callbackUrl, 0));
    return response;
  }
  const state = request.nextUrl.searchParams.get("state") ?? undefined;
  if (!statesMatch(state, request.cookies.get(STATE_COOKIE)?.value)) return result("invalid_state");
  try {
    if (!await consumeOAuthState(hashToken(state!))) return result("invalid_state");
  } catch {
    return result("storage_error");
  }
  if (request.nextUrl.searchParams.has("error")) return result("denied");
  const code = request.nextUrl.searchParams.get("code");
  if (!code) return result("missing_code");
  let scopes = parseStravaScopes(request.nextUrl.searchParams.get("scope") ?? "");
  if (!scopes.includes("activity:read_all")) return result("missing_scope");

  let authorization;
  try {
    authorization = await exchangeStravaCode(code);
  } catch {
    return result("exchange_failed");
  }
  if (authorization.expires_at * 1000 <= Date.now()) return result("exchange_failed");
  if (authorization.scope !== undefined) scopes = parseStravaScopes(authorization.scope);
  if (!scopes.includes("activity:read_all")) return result("missing_scope");
  const sessionToken = newOpaqueToken();
  const previousToken = request.cookies.get(SESSION_COOKIE)?.value;
  try {
    await saveStravaAuthorization(authorization, scopes, {
      tokenHash: hashToken(sessionToken),
      expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000),
      ...(validOpaqueToken(previousToken) ? { previousTokenHash: hashToken(previousToken) } : {}),
    });
  } catch {
    return result("storage_error");
  }
  const response = result("connected");
  response.cookies.set(SESSION_COOKIE, sessionToken, authCookieOptions(callbackUrl, SESSION_SECONDS));
  return response;
}