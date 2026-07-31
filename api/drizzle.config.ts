import { defineConfig } from "drizzle-kit";

const DEFAULT_LOCAL_DATABASE_URL = "postgres://grantfox:grantfox@localhost:5433/grantfox";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL,
  },
});
