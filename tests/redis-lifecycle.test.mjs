import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

assert.match(process.env.OAUTH_TEST_DATABASE ?? "", /^planner_oauth_test_[a-f0-9]{16}$/);

test("empty recovery scans await Redis initialization before closing", () => {
  // Reproduce the handshake/close race deterministically, without dropping a real
  // Redis connection or installing a global uncaughtException handler.
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { RedisConnection } from 'bullmq';
    import { EventEmitter } from 'node:events';
    import { startSyncRecovery } from './apps/worker/src/recovery.ts';
    import { startPlanRecovery } from './apps/worker/src/plan-recovery.ts';
    import { prisma } from '@pkg/db';
    // Warm Postgres so the empty scan finishes before the delayed handshake.
    await prisma.jobRun.count();
    let initializations = 0;
    RedisConnection.prototype.init = function() {
      initializations++;
      this._client = Object.assign(new EventEmitter(), { disconnect() {}, status: 'connecting' });
      return new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })), 200));
    };
    const stopSync = startSyncRecovery(); const stopPlan = startPlanRecovery();
    await Promise.all([stopSync(), stopPlan()]);
    await new Promise(resolve => setTimeout(resolve, 250));
    await prisma.$disconnect();
    if (initializations !== 2) throw Error('Both recovery connections must be tested');
    console.log('survived');
  `], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /survived/);
});
