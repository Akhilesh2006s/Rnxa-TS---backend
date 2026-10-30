import { PrismaClient } from "@prisma/client";

// Each write is a network round trip to Atlas, so a bulk submit or approval
// of a full week can take longer than Prisma's 5-second default.
export const prisma = new PrismaClient({
  transactionOptions: { maxWait: 10_000, timeout: 60_000 },
});
