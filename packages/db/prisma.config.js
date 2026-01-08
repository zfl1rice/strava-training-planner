const path = require("path");
const { defineConfig, env } = require("prisma/config");

// Load the repo-root .env even though Prisma is running with CWD=packages/db
require("dotenv").config({
  path: path.join(__dirname, "..", "..", ".env"),
});

module.exports = defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
