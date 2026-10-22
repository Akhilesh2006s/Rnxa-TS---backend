import os from "node:os";
import path from "node:path";
import "dotenv/config";
import { defineConfig } from "vitest/config";

// Tests run against a separate database on the same cluster ("rnxats_test"),
// never the application database. Records use unique names, so no reset is needed.
const base = process.env.DATABASE_URL ?? "";
if (!base.startsWith("mongodb")) throw new Error("Set DATABASE_URL in server/.env to run tests.");
const testDb = base.replace(/\/rnxats(?=\?|$)/, "/rnxats_test");
if (testDb === base) throw new Error("Expected DATABASE_URL to point at the rnxats database.");
process.env.DATABASE_URL = testDb;

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./test/globalSetup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      DATABASE_URL: testDb,
      SESSION_SECRET: "test-secret-test-secret-test-secret-123",
      ANTHROPIC_API_KEY: "",
      SUPERADMIN_EMAIL: "superadmin@test.local",
      NODE_ENV: "test",
      UPLOAD_DIR: path.join(os.tmpdir(), "rnxa-test-uploads"),
      ATTACHMENT_MAX_MB: "1",
    },
  },
});
