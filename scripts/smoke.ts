import { createIndexes } from "../src/lib/indexes";
import { accountKey } from "../src/lib/keys";
import {
  accountActivityJoin,
  accountById,
  accountPortfolioJoin,
  accountSnapshot,
  positionsByAccount,
  securityById,
  securityByNo,
  transactionsSearch
} from "../src/lib/queries";
import { serializeQueryResponse } from "../src/lib/query-response";
import { closeRedisClient, getRedisClient } from "../src/lib/redis";

async function main() {
  const client = await getRedisClient();
  await createIndexes(client);

  const accountId = process.env.SMOKE_ACCOUNT_ID ?? "A00000001";
  const securityId = process.env.SMOKE_SECURITY_ID ?? "SEC00000001";
  const securityNo = process.env.SMOKE_SECURITY_NO ?? "SPX000001";

  const checks = [
    ["accountById", () => accountById({ client }, accountId)],
    ["securityById", () => securityById({ client }, securityId)],
    ["securityByNo", () => securityByNo({ client }, securityNo)],
    ["positionsByAccount", () => positionsByAccount({ client }, accountId)],
    ["transactionsByAccount", () => transactionsSearch({ client }, { accountId, limit: 20 })],
    ["accountPortfolioJoin", () => accountPortfolioJoin({ client }, accountId)],
    ["accountActivityJoin", () => accountActivityJoin({ client }, accountId)],
    ["accountSnapshot", () => accountSnapshot({ client }, accountId)]
  ] as const;

  console.log(`Smoke account key: ${accountKey(accountId)}`);
  for (const [name, run] of checks) {
    const result = await run();
    const serialized = serializeQueryResponse(result);
    console.log(
      `${name}: count=${result.result_count} bytes=${serialized.payloadBytes} total_ms=${result.timing.total_ms} redis_ms=${result.timing.redis_ms}`
    );
  }

  const account = await accountById({ client }, accountId);
  console.log(`Account document size check: ${serializeQueryResponse(account).payloadBytes} bytes`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedisClient();
  });
