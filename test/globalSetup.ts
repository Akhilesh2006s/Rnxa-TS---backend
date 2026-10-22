import { execSync } from "node:child_process";

// Syncs indexes/collections into the dedicated test database chosen in vitest.config.ts.
// Non-destructive: tests create their own uniquely named records.
export default function setup() {
  execSync("npx prisma db push --skip-generate", { stdio: "inherit", env: process.env });
}
