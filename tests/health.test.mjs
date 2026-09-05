import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { prisma } from "@pkg/db";
import { GET as postgresHealth } from "../apps/web/src/app/api/postgres_health/route.ts";
import { GET as redisHealth } from "../apps/web/src/app/api/redis_health/route.ts";

assert.match(process.env.OAUTH_TEST_DATABASE ?? "", /^planner_oauth_test_[a-f0-9]{16}$/);
assert.equal(new URL(process.env.DATABASE_URL).pathname, `/${process.env.OAUTH_TEST_DATABASE}`);
const redisUrl = process.env.REDIS_URL;
afterEach(() => { process.env.REDIS_URL = redisUrl; });
after(async () => { await prisma.$disconnect(); });

test("health endpoints check real dependencies and prevent response caching", async () => {
  for (const getHealth of [postgresHealth, redisHealth]) {
    const response = await getHealth();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).ok, true);
  }
});

test("database failures do not expose internal errors", async () => {
  // Exercise a real schema error in the harness's isolated database.
  await prisma.$executeRaw`ALTER TABLE "User" RENAME TO "PrivateHealthProbe"`;
  try {
    const response = await postgresHealth();
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.message, "Postgres is unavailable");
    assert.deepEqual(Object.keys(body).sort(), ["db", "message", "ok", "ts"]);
  } finally {
    await prisma.$executeRaw`ALTER TABLE "PrivateHealthProbe" RENAME TO "User"`;
  }
});

test("missing or unreachable Redis returns promptly without leaking connection details", async () => {
  delete process.env.REDIS_URL;
  assert.equal((await redisHealth()).status, 503);
  process.env.REDIS_URL = "redis://:private-password@127.0.0.1:1";
  const start = Date.now();
  const response = await redisHealth();
  assert.equal(response.status, 503);
  assert.ok(Date.now() - start < 6000);
  assert.doesNotMatch(await response.text(), /private-password|127\.0\.0\.1/);
});
