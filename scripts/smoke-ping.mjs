import assert from "node:assert/strict";
import { config } from "dotenv";
import { Queue, QueueEvents, Job } from "bullmq";
import { JOBS, QUEUES, bullConnectionFromUrl } from "@pkg/shared";

config({ path: new URL("../.env", import.meta.url), quiet: true });
const connection = bullConnectionFromUrl(process.env.REDIS_URL);
const queue = new Queue(QUEUES.jobs, { connection });
const events = new QueueEvents(QUEUES.jobs, { connection });
const baseUrl = process.env.WEB_URL ?? "http://localhost:3000";
const timeout = setTimeout(() => {
  console.error("Ping smoke test timed out; check Redis, web, and worker.");
  process.exit(1);
}, 60000);

try {
  await events.waitUntilReady();
  const response = await fetch(`${baseUrl}/api/enqueue/ping`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: 1 }),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 202, await response.clone().text());
  const { jobId } = await response.json();
  assert.ok(jobId);
  const job = await Job.fromId(queue, jobId);
  assert.ok(job, "HTTP endpoint must enqueue in the same Redis queue");
  const result = await job.waitUntilFinished(events, 15000);
  assert.deepEqual(result, { processed: true, userId: 1 });
  console.log("PASS: HTTP -> Redis/BullMQ -> worker -> validated PingJob result");
  await job.remove();

  const badResponse = await fetch(`${baseUrl}/api/enqueue/ping`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "invalid" }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(badResponse.status, 400);
  console.log("PASS: web rejects invalid payload");

  for (const [name, data, message] of [
    [JOBS.ping, { userId: "invalid" }, /Invalid PingJob/],
    ["unknown_smoke_job", { userId: 1 }, /Unsupported job/],
  ]) {
    const invalid = await queue.add(name, data, { attempts: 3 });
    await assert.rejects(invalid.waitUntilFinished(events, 10000), message);
    const failed = await Job.fromId(queue, invalid.id);
    assert.equal(failed.attemptsMade, 1);
    await invalid.remove();
  }
  console.log("PASS: worker rejects invalid payloads and unknown jobs without retrying");
} finally {
  clearTimeout(timeout);
  await events.close();
  await queue.close();
}