import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// Each suite owns a disposable database and queue prefix. Never use athlete records.
const build = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "apps/worker/tsconfig.json"], { cwd: root, stdio: "inherit", windowsHide: true });
if (build.status !== 0) process.exit(build.status ?? 1);
for (const suite of ["oauth", "sync", "training", "planner", "health", "calendar", "planning", "adaptive", "semantics", "openai", "settings", "blocks", "reviews", "review-jobs", "redis", "training-ui"]) {
  const result = spawnSync(process.execPath, ["scripts/test-strava.mjs", suite], { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const ping = spawnSync(process.execPath, ["--import", "tsx", "--test", "tests/ping-route.test.mjs"], {
  cwd: root, stdio: "inherit", windowsHide: true, env: { ...process.env, TSX_TSCONFIG_PATH: `${root}/apps/web/tsconfig.json` },
});
process.exitCode = ping.status ?? 1;
