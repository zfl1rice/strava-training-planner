import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getSessionUser } from "@pkg/db";
import { getStravaCredentials } from "@pkg/shared/strava";

export const STATE_COOKIE = "strava_oauth_state";
export const SESSION_COOKIE = "planner_session";
export const STATE_SECONDS = 10 * 60;
export const SESSION_SECONDS = 30 * 24 * 60 * 60;

export function getStravaConfig() {
  const credentials = getStravaCredentials();
  const callbackUrl = new URL(process.env.STRAVA_REDIRECT_URI ?? "http://localhost:3000/api/strava/callback");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(callbackUrl.hostname);
  if (
    (!local && callbackUrl.protocol !== "https:") ||
    !["http:", "https:"].includes(callbackUrl.protocol) ||
    callbackUrl.pathname !== "/api/strava/callback" ||
    callbackUrl.search || callbackUrl.hash || callbackUrl.username || callbackUrl.password
  ) throw new Error("Invalid STRAVA_REDIRECT_URI");
  return { ...credentials, callbackUrl };
}

export const newOpaqueToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function validOpaqueToken(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9_-]{43}$/.test(value));
}

export function statesMatch(query: string | undefined, cookie: string | undefined): boolean {
  return validOpaqueToken(query) && validOpaqueToken(cookie) &&
    timingSafeEqual(Buffer.from(query), Buffer.from(cookie));
}

export function authCookieOptions(callbackUrl: URL, maxAge: number) {
  return { httpOnly: true, sameSite: "lax" as const, secure: callbackUrl.protocol === "https:", path: "/", maxAge };
}

export async function userFromSession(token: string | undefined) {
  return validOpaqueToken(token) ? getSessionUser(hashToken(token)) : null;
}