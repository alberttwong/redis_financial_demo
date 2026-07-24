import { INDEXES } from "../src/lib/indexes";
import { jsonGet } from "../src/lib/json";
import { disconnectRedisPool, getRedisClient } from "../src/lib/redis";
import { searchKeys } from "../src/lib/search";

const seedAccounts = Number(process.env.SEED_ACCOUNTS ?? "6600");
const expected = {
  accounts: seedAccounts,
  securities: Number(process.env.SEED_SECURITIES ?? "3960"),
  positions:
    seedAccounts * Number(process.env.SEED_POSITIONS_PER_ACCOUNT ?? "500"),
  transactions: Number(process.env.SEED_TRANSACTIONS ?? "240900000"),
  snapshots: seedAccounts
};

const pollSeconds = Number(process.env.RESTORE_POLL_SECONDS ?? "30");
const timeoutSeconds = Number(process.env.RESTORE_TIMEOUT_SECONDS ?? "7200");
const accountId = process.env.RESTORE_PROBE_ACCOUNT_ID ?? "A00000001";

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutSeconds * 1_000;
  const client = await getRedisClient();

  try {
    while (Date.now() < deadline) {
      try {
        const [accounts, securities, positions, transactions, snapshots, probe] =
          await Promise.all([
            searchKeys(client, INDEXES.accounts, "*", { limit: 0 }),
            searchKeys(client, INDEXES.securities, "*", { limit: 0 }),
            searchKeys(client, INDEXES.positions, "*", { limit: 0 }),
            searchKeys(client, INDEXES.transactions, "*", { limit: 0 }),
            searchKeys(client, INDEXES.snapshots, "*", { limit: 0 }),
            jsonGet(client, `acct:{acct:${accountId}}:info`)
          ]);

        const counts = {
          accounts: accounts.total,
          securities: securities.total,
          positions: positions.total,
          transactions: transactions.total,
          snapshots: snapshots.total
        };
        const elapsedSeconds = Math.round((Date.now() - startedAt) / 1_000);
        console.log(
          JSON.stringify({
            elapsed_seconds: elapsedSeconds,
            counts,
            probe_account_present: probe !== null
          })
        );

        const ready =
          counts.accounts >= expected.accounts &&
          counts.securities >= expected.securities &&
          counts.positions >= expected.positions &&
          counts.transactions >= expected.transactions &&
          counts.snapshots >= expected.snapshots &&
          probe !== null;

        if (ready) {
          console.log(
            JSON.stringify({
              status: "ready",
              expected,
              elapsed_seconds: elapsedSeconds
            })
          );
          return;
        }
      } catch (error) {
        console.error(
          JSON.stringify({
            status: "waiting",
            error: error instanceof Error ? error.message : String(error)
          })
        );
      }

      await sleep(pollSeconds * 1_000);
    }

    throw new Error(
      `Restored dataset did not become ready within ${timeoutSeconds} seconds`
    );
  } finally {
    await disconnectRedisPool();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
