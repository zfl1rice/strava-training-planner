import assert from "node:assert/strict";
import { after, test } from "node:test";
import { POST } from "../apps/web/src/app/api/enqueue/ping/route.ts";

const originalFlag = process.env.ENABLE_PING_DIAGNOSTICS;
const originalRedisUrl = process.env.REDIS_URL;
after(() => {
  if (originalFlag === undefined) delete process.env.ENABLE_PING_DIAGNOSTICS;
  else process.env.ENABLE_PING_DIAGNOSTICS = originalFlag;
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
});

test("Ping is disabled unless explicitly true, before reading input or initializing Redis", async () => {
  delete process.env.REDIS_URL;
  for (const flag of [undefined, "", "false", "0", "1", "TRUE", "yes", " true "]) {
    if (flag === undefined) delete process.env.ENABLE_PING_DIAGNOSTICS;
    else process.env.ENABLE_PING_DIAGNOSTICS = flag;
    const response = await POST({ text() { assert.fail("Disabled diagnostics must not read the request"); } });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ok: false, message: "Not found" });
    assert.equal(globalThis.pingQueue, undefined);
  }
});

test("request parameters cannot enable Ping diagnostics", async () => {
  delete process.env.ENABLE_PING_DIAGNOSTICS;
  const response = await POST(new Request("http://localhost/api/enqueue/ping?ENABLE_PING_DIAGNOSTICS=true", {
    method: "POST", headers: { ENABLE_PING_DIAGNOSTICS: "true" },
    body: JSON.stringify({ userId: 1, ENABLE_PING_DIAGNOSTICS: true }),
  }));
  assert.equal(response.status, 404);
  assert.equal(globalThis.pingQueue, undefined);
});

test("explicitly enabled diagnostics still validate JSON and payloads before queue access", async () => {
  process.env.ENABLE_PING_DIAGNOSTICS = "true";
  for (const body of ["{invalid", JSON.stringify({ userId: "invalid" })]) {
    const response = await POST(new Request("http://localhost/api/enqueue/ping", { method: "POST", body }));
    assert.equal(response.status, 400);
    assert.equal(globalThis.pingQueue, undefined);
  }
});

test("diagnostics can be disabled again without a rebuild", async () => {
  process.env.ENABLE_PING_DIAGNOSTICS = "false";
  const response = await POST(new Request("http://localhost/api/enqueue/ping", { method: "POST", body: "{invalid" }));
  assert.equal(response.status, 404);
});
