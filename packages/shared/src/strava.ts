// Server-only entry point: import from @pkg/shared/strava, never from client UI.
import { StravaAuthorizationSchema, StravaTokensSchema } from "./stravaSchemas.js";

export function getStravaCredentials() {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !/^\d+$/.test(clientId) || !clientSecret?.trim()) {
    throw new Error("Configure STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET");
  }
  return { clientId, clientSecret };
}

export class StravaTokenError extends Error {
  constructor(public readonly status: number) {
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
  if (!response.ok) throw new StravaTokenError(response.status);
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
