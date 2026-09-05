import { defineConfig, env } from "prisma/config";
import { config } from "dotenv";

// Load the repo-root .env even though Prisma is running with CWD=packages/db
config({
  path: new URL("../../.env", import.meta.url),
  quiet: true,
});

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
