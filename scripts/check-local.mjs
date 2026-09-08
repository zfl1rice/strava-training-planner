import { config } from "dotenv";
import { readFileSync, existsSync } from "node:fs";
import { parse } from "dotenv";
import pg from "pg";
import Redis from "ioredis";

config({ path: new URL("../apps/worker/.env.local", import.meta.url), quiet: true });
config({ path: new URL("../.env", import.meta.url), quiet: true });
const file = new URL("../apps/web/.env.local", import.meta.url);
const web = existsSync(file) ? parse(readFileSync(file)) : {};
const checks = [];
const check = (name, ok) => { checks.push(ok); console.log(`${ok ? "PASS" : "CHECK"}: ${name}`); };
console.log("Read-only local checks. No credentials are printed; no API requests or jobs are created.");
check(`Worker provider: ${process.env.PLANNER_PROVIDER ?? "deterministic"}`, ["openai", "deterministic", undefined].includes(process.env.PLANNER_PROVIDER));
check("Worker key set when using OpenAI", process.env.PLANNER_PROVIDER !== "openai" || Boolean(process.env.OPENAI_API_KEY?.trim()));
check("Web file contains no OpenAI key", !Object.keys(web).some(key => key.includes("OPENAI") && key.includes("KEY") && web[key]));
check("Web/worker database settings match locally", Boolean(web.DATABASE_URL) && web.DATABASE_URL === process.env.DATABASE_URL);
check("Web/worker Redis settings match locally", Boolean(web.REDIS_URL) && web.REDIS_URL === process.env.REDIS_URL);
check("Web/worker queue prefixes match", (web.BULLMQ_PREFIX ?? "bull") === (process.env.BULLMQ_PREFIX ?? "bull"));
const database = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
try {
  await database.connect();
  const result = await database.query('SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = \'JobRun\' AND column_name = \'reviewRequest\') AS ready');
  check("Postgres reachable and review-job migration applied", result.rows[0].ready);
} catch { check("Postgres reachable", false); }
finally { await database.end().catch(() => {}); }
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { lazyConnect: true, connectTimeout: 5000, maxRetriesPerRequest: 0, retryStrategy: () => null });
redis.on("error", () => {});
try { await redis.connect(); check("Redis PING", await redis.ping() === "PONG"); }
catch { check("Redis reachable", false); }
finally { redis.disconnect(); }
process.exitCode = checks.every(Boolean) ? 0 : 1;
