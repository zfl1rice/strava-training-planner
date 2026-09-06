import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";

const root = fileURLToPath(new URL("../", import.meta.url));
const testFiles = {
  oauth: "tests/strava-oauth.test.mjs",
  sync: "tests/activity-sync.test.mjs",
  training: "tests/training-summary.test.mjs",
  planner: "tests/planner.test.mjs",
  health: "tests/health.test.mjs",
  calendar: "tests/calendar.test.mjs",
  planning: "tests/planning-context.test.mjs",
  adaptive: "tests/adaptive-planner.test.mjs",
  settings: "tests/planning-settings.test.mjs",
};
const testFile = testFiles[process.argv[2] ?? "oauth"];
if (!testFile) throw new Error("Unknown integration test suite");
config({ path: new URL("../.env", import.meta.url), quiet: true });
if (!process.env.DATABASE_URL) throw new Error("Configure DATABASE_URL first");
const databaseName = `planner_oauth_test_${randomBytes(8).toString("hex")}`;
const databaseUrl = new URL(process.env.DATABASE_URL);
databaseUrl.pathname = `/${databaseName}`;
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl.toString(),
  OAUTH_TEST_DATABASE: databaseName,
  BULLMQ_PREFIX: databaseName,
  STRAVA_CLIENT_ID: "12345",
  STRAVA_CLIENT_SECRET: "test-only-client-secret",
  STRAVA_REDIRECT_URI: "http://localhost:3000/api/strava/callback",
  TSX_TSCONFIG_PATH: fileURLToPath(new URL("../apps/web/tsconfig.json", import.meta.url)),
  WRITE_PLANNING_CONTEXT_EXAMPLE: process.argv.includes("--example") ? "true" : "false",
};
let created = false;
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  console.log("Created isolated test database; application records are untouched.");
  const migration = spawnSync(process.execPath, [
    fileURLToPath(new URL("../node_modules/prisma/build/index.js", import.meta.url)), "migrate", "deploy",
  ], { cwd: fileURLToPath(new URL("../packages/db/", import.meta.url)), env, stdio: "inherit", timeout: 60000, windowsHide: true });
  if (migration.error || migration.status !== 0) throw new Error("Test database migration failed");
  const tests = spawnSync(process.execPath, [
    "--import", "tsx", "--test", "--test-concurrency=1", testFile,
  ], { cwd: root, env, stdio: "inherit", timeout: 90000, windowsHide: true });
  process.exitCode = tests.status ?? 1;
  if (tests.error) console.error(tests.error.message);
} finally {
  if (created && /^planner_oauth_test_[a-f0-9]{16}$/.test(databaseName)) {
    await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    console.log("Removed isolated test database.");
  }
  await admin.end();
}
