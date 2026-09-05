import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { NextRequest } from "next/server.js";
import { prisma, getValidStravaAccessToken, getSessionUser } from "@pkg/db";
import { refreshStravaTokens } from "@pkg/shared/strava";
import { POST as connect } from "../apps/web/src/app/api/strava/connect/route.ts";
import { GET as callback } from "../apps/web/src/app/api/strava/callback/route.ts";
import { POST as refresh } from "../apps/web/src/app/api/strava/refresh/route.ts";
import { hashToken, newOpaqueToken, getStravaConfig, authCookieOptions } from "../apps/web/src/lib/strava-auth.ts";

// Only the harness's randomly named database may be cleared by these tests.
assert.match(process.env.OAUTH_TEST_DATABASE ?? "", /^planner_oauth_test_[a-f0-9]{16}$/);
assert.equal(new URL(process.env.DATABASE_URL).pathname, `/${process.env.OAUTH_TEST_DATABASE}`);
const origin = "http://localhost:3000";
const athleteId = 901234;
const tokens = () => ({
  access_token: "test-access-token", refresh_token: "test-refresh-token",
  expires_at: Math.floor(Date.now() / 1000) + 21600,
});
const authorization = () => ({ ...tokens(), athlete: { id: athleteId, firstname: "Test", lastname: "Athlete" } });

beforeEach(async () => {
  mock.restoreAll();
  process.env.STRAVA_CLIENT_ID = "12345";
  process.env.STRAVA_CLIENT_SECRET = "test-only-client-secret";
  process.env.STRAVA_REDIRECT_URI = `${origin}/api/strava/callback`;
  await prisma.user.deleteMany();
  await prisma.oAuthState.deleteMany();
  mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected external request in test"); });
});
after(async () => { mock.restoreAll(); await prisma.$disconnect(); });

function mockTokens(body = authorization(), status = 200) {
  return mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://www.strava.com/oauth/token");
    assert.equal(options.method, "POST");
    assert.equal(options.body.get("client_id"), "12345");
    assert.equal(options.body.get("client_secret"), "test-only-client-secret");
    return Response.json(body, { status });
  });
}

async function begin() {
  const response = await connect(new NextRequest(`${origin}/api/strava/connect`, {
    method: "POST", headers: { origin },
  }));
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.hostname, "www.strava.com");
  const state = response.cookies.get("strava_oauth_state").value;
  return { response, location, state };
}

function callbackRequest(state, params = {}, sessionToken) {
  const url = new URL(`${origin}/api/strava/callback`);
  url.search = new URLSearchParams({ state, code: "test-code", scope: "read,activity:read_all", ...params });
  return new NextRequest(url, { headers: {
    cookie: `strava_oauth_state=${state}${sessionToken ? `; planner_session=${sessionToken}` : ""}`,
  } });
}

function result(response) { return new URL(response.headers.get("location")).searchParams.get("strava"); }

async function connected() {
  mockTokens();
  const { state } = await begin();
  const response = await callback(callbackRequest(state));
  assert.equal(result(response), "connected");
  const token = response.cookies.get("planner_session").value;
  const connection = await prisma.stravaConnection.findUniqueOrThrow({ where: { athleteId: BigInt(athleteId) } });
  return { token, connection, response };
}

function refreshRequest(token, requestOrigin = origin) {
  return new NextRequest(`${origin}/api/strava/refresh`, { method: "POST", headers: {
    origin: requestOrigin, ...(token ? { cookie: `planner_session=${token}` } : {}),
  } });
}

test("connect redirects with scoped authorization and a hashed, expiring state", async () => {
  const { response, location, state } = await begin();
  assert.equal(location.searchParams.get("scope"), "read,activity:read_all");
  assert.equal(location.searchParams.get("redirect_uri"), `${origin}/api/strava/callback`);
  assert.equal(location.searchParams.get("state"), state);
  assert.equal(location.searchParams.has("client_secret"), false);
  const saved = await prisma.oAuthState.findUniqueOrThrow({ where: { tokenHash: hashToken(state) } });
  assert.notEqual(saved.tokenHash, state);
  assert.ok(saved.expiresAt.getTime() > Date.now());
  assert.ok(saved.expiresAt.getTime() <= Date.now() + 600000);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(response.headers.get("set-cookie"), /SameSite=lax/i);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("missing config and cross-origin connect are handled before creating state", async () => {
  const crossOrigin = await connect(new NextRequest(`${origin}/api/strava/connect`, {
    method: "POST", headers: { origin: "https://unrelated.example" },
  }));
  assert.equal(crossOrigin.status, 403);
  delete process.env.STRAVA_CLIENT_SECRET;
  const missing = await connect(new NextRequest(`${origin}/api/strava/connect`, { method: "POST" }));
  assert.equal(result(missing), "config_error");
  assert.equal(await prisma.oAuthState.count(), 0);
});

test("HTTPS cookies are secure and nonlocal HTTP callbacks are rejected", () => {
  process.env.STRAVA_REDIRECT_URI = "https://planner.example/api/strava/callback";
  assert.equal(authCookieOptions(getStravaConfig().callbackUrl, 600).secure, true);
  process.env.STRAVA_REDIRECT_URI = "http://planner.example/api/strava/callback";
  assert.throws(getStravaConfig, /Invalid STRAVA_REDIRECT_URI/);
});

test("missing, mismatched, expired, and unknown state cannot authorize", async () => {
  const { state } = await begin();
  const noCookie = new NextRequest(`${origin}/api/strava/callback?state=${state}&code=test`);
  assert.equal(result(await callback(noCookie)), "invalid_state");
  assert.equal(result(await callback(callbackRequest(state, { state: newOpaqueToken() }))), "invalid_state");
  await prisma.oAuthState.update({ where: { tokenHash: hashToken(state) }, data: { expiresAt: new Date(0) } });
  assert.equal(result(await callback(callbackRequest(state))), "invalid_state");
  assert.equal(result(await callback(callbackRequest(newOpaqueToken()))), "invalid_state");
  assert.equal(await prisma.user.count(), 0);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("denial, missing code, and missing activity scope consume state without exchanging tokens", async () => {
  for (const [params, expected] of [
    [{ error: "access_denied" }, "denied"],
    [{ code: "" }, "missing_code"],
    [{ scope: "read,activity:read" }, "missing_scope"],
  ]) {
    const { state } = await begin();
    const response = await callback(callbackRequest(state, params));
    assert.equal(result(response), expected);
    assert.equal(response.cookies.get("strava_oauth_state").maxAge, 0);
    assert.equal(result(await callback(callbackRequest(state))), "invalid_state");
  }
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("callback stores athlete and tokens, creates an opaque session, and blocks replay", async () => {
  const fetchMock = mockTokens();
  const { state } = await begin();
  const response = await callback(callbackRequest(state));
  assert.equal(result(response), "connected");
  const connection = await prisma.stravaConnection.findUniqueOrThrow({ where: { athleteId: BigInt(athleteId) }, include: { user: true } });
  assert.equal(connection.user.name, "Test Athlete");
  assert.equal(connection.user.email, null);
  assert.equal(connection.accessToken, "test-access-token");
  assert.equal(connection.refreshToken, "test-refresh-token");
  assert.deepEqual(connection.scopes, ["activity:read_all", "read"]);
  const cookie = response.cookies.get("planner_session");
  assert.ok(cookie.httpOnly);
  const session = await prisma.session.findUniqueOrThrow({ where: { tokenHash: hashToken(cookie.value) } });
  assert.equal(session.userId, connection.userId);
  assert.equal((await getSessionUser(hashToken(cookie.value))).id, connection.userId);
  assert.doesNotMatch(JSON.stringify([...response.headers]), /test-access-token|test-refresh-token|test-only-client-secret/);
  assert.equal(fetchMock.mock.calls[0].arguments[1].body.get("code"), "test-code");
  assert.equal(result(await callback(callbackRequest(state))), "invalid_state");
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("reconnect reuses the athlete and rotates the browser session", async () => {
  const original = await connected();
  mockTokens({ ...authorization(), access_token: "reconnected-access", refresh_token: "reconnected-refresh" });
  const { state } = await begin();
  const response = await callback(callbackRequest(state, {}, original.token));
  assert.equal(result(response), "connected");
  assert.notEqual(response.cookies.get("planner_session").value, original.token);
  assert.equal(await getSessionUser(hashToken(original.token)), null);
  assert.equal(await prisma.user.count(), 1);
  assert.equal(await prisma.stravaConnection.count(), 1);
  const saved = await prisma.stravaConnection.findUniqueOrThrow({ where: { userId: original.connection.userId } });
  assert.equal(saved.refreshToken, "reconnected-refresh");
});

test("simultaneous first callbacks cannot create duplicate athletes or users", async () => {
  mockTokens();
  const first = await begin();
  const second = await begin();
  const responses = await Promise.all([callback(callbackRequest(first.state)), callback(callbackRequest(second.state))]);
  assert.deepEqual(responses.map(result), ["connected", "connected"]);
  assert.equal(await prisma.user.count(), 1);
  assert.equal(await prisma.stravaConnection.count(), 1);
});

test("bad Strava responses and insufficient returned scopes never create a session", async () => {
  for (const [body, status, expected] of [
    [{ error: "test-only-client-secret" }, 400, "exchange_failed"],
    [{ ...authorization(), access_token: null }, 200, "exchange_failed"],
    [{ ...authorization(), expires_at: 1 }, 200, "exchange_failed"],
    [{ ...authorization(), scope: "read" }, 200, "missing_scope"],
  ]) {
    mockTokens(body, status);
    const { state } = await begin();
    const response = await callback(callbackRequest(state));
    assert.equal(result(response), expected);
    assert.equal(response.cookies.has("planner_session"), false);
    assert.doesNotMatch(response.headers.get("location"), /test-only-client-secret/);
  }
  assert.equal(await prisma.user.count(), 0);
});

test("a valid access token avoids a refresh request and is never returned to the browser", async () => {
  const { token } = await connected();
  const fetchMock = mockTokens(tokens());
  const response = await refresh(refreshRequest(token));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(body, /test-access-token|test-refresh-token/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("concurrent expiry refreshes rotate both tokens once using the latest saved refresh token", async () => {
  const { connection } = await connected();
  await prisma.stravaConnection.update({ where: { userId: connection.userId }, data: { expiresAt: new Date(0) } });
  const fetchMock = mockTokens({ ...tokens(), access_token: "rotated-access", refresh_token: "rotated-refresh" });
  const results = await Promise.all([
    getValidStravaAccessToken(connection.userId, refreshStravaTokens),
    getValidStravaAccessToken(connection.userId, refreshStravaTokens),
  ]);
  assert.deepEqual(results, ["rotated-access", "rotated-access"]);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(fetchMock.mock.calls[0].arguments[1].body.get("refresh_token"), "test-refresh-token");
  const saved = await prisma.stravaConnection.findUniqueOrThrow({ where: { userId: connection.userId } });
  assert.equal(saved.refreshToken, "rotated-refresh");
  assert.equal(saved.accessToken, "rotated-access");
  await prisma.stravaConnection.update({ where: { userId: connection.userId }, data: { expiresAt: new Date(Date.now() + 30000) } });
  await getValidStravaAccessToken(connection.userId, refreshStravaTokens);
  assert.equal(fetchMock.mock.calls[1].arguments[1].body.get("refresh_token"), "rotated-refresh");
});

test("refresh failures preserve saved tokens and tell the caller to reconnect or retry", async () => {
  const { token, connection } = await connected();
  await prisma.stravaConnection.update({ where: { userId: connection.userId }, data: { expiresAt: new Date(0) } });
  for (const [status, expected] of [[400, 401], [401, 401], [429, 503], [500, 503]]) {
    mockTokens({ message: "sensitive-provider-error" }, status);
    const response = await refresh(refreshRequest(token));
    assert.equal(response.status, expected);
    assert.doesNotMatch(await response.text(), /sensitive-provider-error|test-refresh-token/);
    const saved = await prisma.stravaConnection.findUniqueOrThrow({ where: { userId: connection.userId } });
    assert.equal(saved.refreshToken, "test-refresh-token");
    assert.equal(saved.expiresAt.getTime(), 0);
  }
});

test("refresh requires a valid unexpired session and the correct origin", async () => {
  assert.equal((await refresh(refreshRequest())).status, 401);
  assert.equal((await refresh(refreshRequest(newOpaqueToken()))).status, 401);
  assert.equal((await refresh(refreshRequest(undefined, "https://unrelated.example"))).status, 403);
  const { token } = await connected();
  await prisma.session.update({ where: { tokenHash: hashToken(token) }, data: { expiresAt: new Date(0) } });
  assert.equal((await refresh(refreshRequest(token))).status, 401);
});
