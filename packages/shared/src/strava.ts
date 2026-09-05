// Server-only entry point: import from @pkg/shared/strava, never from client UI.
import { StravaAuthorizationSchema, StravaTokensSchema, StravaActivitiesSchema } from "./stravaSchemas.js";

export function getStravaCredentials() {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !/^\d+$/.test(clientId) || !clientSecret?.trim()) {
    throw new Error("Configure STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET");
  }
  return { clientId, clientSecret };
}

export class StravaTokenError extends Error {
  constructor(public readonly status: number, public readonly retryAfterMs = 0) {
    super(`Strava token request failed (HTTP ${status})`);
    this.name = "StravaTokenError";
  }
}

async function requestTokens(fields: Record<string, string>): Promise<unknown> {
  const { clientId, clientSecret } = getStravaCredentials();
  const response = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...fields }),
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  // Do not log the response body: it may contain credentials or tokens.
  if (!response.ok) throw new StravaTokenError(response.status, response.status === 429 ? stravaRateLimitDelay(response.headers) : 0);
  return response.json();
}

export async function exchangeStravaCode(code: string) {
  const parsed = StravaAuthorizationSchema.safeParse(
    await requestTokens({ grant_type: "authorization_code", code }),
  );
  if (!parsed.success) throw new Error("Strava returned an invalid authorization response");
  return parsed.data;
}

export async function refreshStravaTokens(refreshToken: string) {
  const parsed = StravaTokensSchema.safeParse(
    await requestTokens({ grant_type: "refresh_token", refresh_token: refreshToken }),
  );
  if (!parsed.success) throw new Error("Strava returned an invalid refresh response");
  return parsed.data;
}

export class StravaApiError extends Error {
  constructor(public readonly status: number, public readonly retryAfterMs = 0) {
    super(`Strava activity request failed (HTTP ${status})`);
    this.name = "StravaApiError";
  }
}

export class StravaDataError extends Error {}

export function stravaRateLimitDelay(headers: Headers, now = Date.now()): number {
  const retryAfter = headers.get("retry-after");
  let delay = 0;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
  }
  for (const prefix of ["x-ratelimit", "x-readratelimit"]) {
    const dailyLimit = Number(headers.get(`${prefix}-limit`)?.split(",")[1]);
    const dailyUsage = Number(headers.get(`${prefix}-usage`)?.split(",")[1]);
    if (dailyLimit > 0 && dailyUsage >= dailyLimit) {
      const tomorrow = new Date(now);
      tomorrow.setUTCHours(24, 0, 1, 0);
      return Math.max(tomorrow.getTime() - now, Number.isFinite(delay) ? delay : 0);
    }
  }
  if (Number.isFinite(delay) && delay > 0) return Math.max(1000, delay);
  return (Math.floor(now / 900000) + 1) * 900000 - now + 1000;
}

export async function fetchStravaActivities(accessToken: string, window: { after: number; before: number; page: number }) {
  const url = new URL("https://www.strava.com/api/v3/athlete/activities");
  url.search = new URLSearchParams({
    after: String(window.after), before: String(window.before), page: String(window.page), per_page: "200",
  }).toString();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new StravaApiError(response.status, response.status === 429 ? stravaRateLimitDelay(response.headers) : 0);
  const parsed = StravaActivitiesSchema.safeParse(await response.json());
  if (!parsed.success) throw new StravaDataError("Strava returned invalid activity data");
  return parsed.data;
}
