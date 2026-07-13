import { mkdir, writeFile } from "node:fs/promises";
import { getSeedConfig } from "../src/lib/config";
import { INDEXES } from "../src/lib/indexes";
import { accountKey, snapshotKey, transactionKey, transactionId } from "../src/lib/keys";
import { withSizedPayload } from "../src/lib/payload";
import { closeRedisClient, getRedisClient } from "../src/lib/redis";
import { searchKeys } from "../src/lib/search";
import { tagEquals } from "../src/lib/tag";
import type { TransactionRow } from "../src/lib/types";

const TRANSACTION_INDEX = "idx:transactions";

async function main() {
  const config = getSeedConfig();
  await mkdir("monitor-input", { recursive: true });

  const accountLines = Array.from({ length: Math.min(config.accountCount, 1000) }, (_, index) => {
    const accountId = `A${String(index + 1).padStart(8, "0")}`;
    return `"JSON.GET" "${accountKey(accountId)}" "$"`;
  });

  const snapshotLines = Array.from({ length: Math.min(config.accountCount, 1000) }, (_, index) => {
    const accountId = `A${String(index + 1).padStart(8, "0")}`;
    return `"JSON.GET" "${snapshotKey(accountId)}" "$"`;
  });

  const mixedLines = [
    ...accountLines.slice(0, 400),
    ...snapshotLines.slice(0, 300),
    ...Array.from({ length: 300 }, (_, index) => {
      const accountId = `A${String((index % config.accountCount) + 1).padStart(8, "0")}`;
      return `"FT.SEARCH" "idx:transactions" "@account_id:{${accountId}}" "NOCONTENT" "LIMIT" "0" "20" "DIALECT" "2"`;
    })
  ];

  const positionsByAccountLines = makePositionsByAccountLines(config.accountCount);
  const transactionLines = await makeTransactionLines(config.accountCount);
  const tradeWriteLines = makeTradeWriteLines({
    accountCount: config.accountCount,
    securityCount: config.securityCount,
    commandCount: readInt("MEMTIER_TRADE_COMMANDS", 10_000),
    payloadBytes: readInt("MEMTIER_TRADE_PAYLOAD_BYTES", 1024),
    seed: config.randomSeed
  });

  await writeFile("monitor-input/account-reads.txt", accountLines.join("\n") + "\n");
  await writeFile("monitor-input/snapshot-reads.txt", snapshotLines.join("\n") + "\n");
  await writeFile("monitor-input/positions-by-account.txt", positionsByAccountLines.join("\n") + "\n");
  await writeFile("monitor-input/transactions.txt", transactionLines.join("\n") + "\n");
  await writeFile("monitor-input/trade-writes.txt", tradeWriteLines.join("\n") + "\n");
  await writeFile("monitor-input/mixed.txt", mixedLines.join("\n") + "\n");

  console.log("Wrote monitor-input/account-reads.txt");
  console.log("Wrote monitor-input/snapshot-reads.txt");
  console.log("Wrote monitor-input/positions-by-account.txt");
  console.log("Wrote monitor-input/transactions.txt");
  console.log("Wrote monitor-input/trade-writes.txt");
  console.log("Wrote monitor-input/mixed.txt");
}

function makePositionsByAccountLines(accountCount: number): string[] {
  return Array.from({ length: Math.min(accountCount, 1000) }, (_, index) => {
    const accountId = `A${String((index % accountCount) + 1).padStart(8, "0")}`;
    return `"FT.SEARCH" "${INDEXES.positions}" "${tagEquals("account_id", accountId)}" "NOCONTENT" "LIMIT" "0" "500" "DIALECT" "2"`;
  });
}

async function makeTransactionLines(accountCount: number): Promise<string[]> {
  if (!process.env.REDIS_URL) {
    return fallbackTransactionSearchLines(accountCount);
  }

  const maxKeys = readInt("MEMTIER_TRANSACTION_KEYS", 10_000);
  const waitTimeoutMs = readInt(
    "MEMTIER_TRANSACTION_INDEX_WAIT_MS",
    10 * 60 * 1000
  );
  const waitIntervalMs = readInt("MEMTIER_TRANSACTION_INDEX_POLL_MS", 5_000);

  try {
    const client = await getRedisClient();
    await waitForTransactionIndex(client, waitTimeoutMs, waitIntervalMs);

    const keys: string[] = [];
    const pageSize = 1000;

    for (let offset = 0; keys.length < maxKeys; offset += pageSize) {
      const page = await searchKeys(client, TRANSACTION_INDEX, "*", {
        offset,
        limit: Math.min(pageSize, maxKeys - keys.length)
      });
      keys.push(...page.keys);
      if (keys.length >= page.total || page.keys.length === 0) break;
    }

    await closeRedisClient();

    if (keys.length > 0) {
      return keys.map((key) => `"JSON.GET" "${key}" "$"`);
    }

    throw new Error(`No transaction keys found in ${TRANSACTION_INDEX} after index readiness check.`);
  } catch (error) {
    await closeRedisClient().catch(() => undefined);
    throw new Error(
      `Could not load live transaction keys from Redis for JSON.GET benchmark input. ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function fallbackTransactionSearchLines(accountCount: number): string[] {
  return Array.from({ length: Math.min(accountCount, 1000) }, (_, index) => {
    const accountId = `A${String((index % accountCount) + 1).padStart(8, "0")}`;
    return `"FT.SEARCH" "idx:transactions" "@account_id:{${accountId}}" "NOCONTENT" "LIMIT" "0" "20" "DIALECT" "2"`;
  });
}

type IndexStatus = {
  indexing: number | null;
  numDocs: number;
  percentIndexed: number | null;
};

async function waitForTransactionIndex(
  client: Awaited<ReturnType<typeof getRedisClient>>,
  timeoutMs: number,
  intervalMs: number
): Promise<void> {
  const startedAt = Date.now();
  let lastStatus: IndexStatus | null = null;

  while (Date.now() - startedAt <= timeoutMs) {
    lastStatus = await transactionIndexStatus(client);

    const indexIsReady =
      lastStatus.numDocs > 0 &&
      lastStatus.indexing === 0 &&
      (lastStatus.percentIndexed === null || lastStatus.percentIndexed >= 1);

    if (indexIsReady) {
      console.log(
        `${TRANSACTION_INDEX}: ready with ${lastStatus.numDocs} docs${
          lastStatus.percentIndexed === null ? "" : `, percent_indexed=${lastStatus.percentIndexed}`
        }`
      );
      return;
    }

    console.log(
      `${TRANSACTION_INDEX}: waiting for backfill, docs=${lastStatus.numDocs}, indexing=${
        lastStatus.indexing ?? "unknown"
      }, percent_indexed=${
        lastStatus.percentIndexed ?? "unknown"
      }`
    );
    await sleep(intervalMs);
  }

  throw new Error(
    `${TRANSACTION_INDEX} was not ready after ${timeoutMs}ms. Last status: docs=${lastStatus?.numDocs ?? "unknown"}, indexing=${
      lastStatus?.indexing ?? "unknown"
    }, percent_indexed=${lastStatus?.percentIndexed ?? "unknown"}`
  );
}

async function transactionIndexStatus(
  client: Awaited<ReturnType<typeof getRedisClient>>
): Promise<IndexStatus> {
  const raw = await client.sendCommand(["FT.INFO", TRANSACTION_INDEX]);
  if (!Array.isArray(raw)) {
    throw new Error(`${TRANSACTION_INDEX}: FT.INFO returned an unexpected response.`);
  }

  const info = new Map<string, unknown>();
  for (let index = 0; index < raw.length; index += 2) {
    info.set(String(raw[index]), raw[index + 1]);
  }

  return {
    indexing: readNumber(info.get("indexing")),
    numDocs: readNumber(info.get("num_docs")) ?? 0,
    percentIndexed: readNumber(info.get("percent_indexed"))
  };
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTradeWriteLines(options: {
  accountCount: number;
  securityCount: number;
  commandCount: number;
  payloadBytes: number;
  seed: number;
}): string[] {
  const random = mulberry32(options.seed);
  const baseTime = Date.UTC(2026, 0, 1);

  return Array.from({ length: options.commandCount }, (_, index) => {
    const accountIndex = Math.floor(random() * options.accountCount) + 1;
    const securityIndex = Math.floor(random() * options.securityCount) + 1;
    const accountId = `A${String(accountIndex).padStart(8, "0")}`;
    const securityId = `SEC${String(securityIndex).padStart(8, "0")}`;
    const tradeDate = new Date(baseTime + index * 1000).toISOString().slice(0, 10);
    const acctTypeCode = ["CASH", "MARGIN", "RETIREMENT", "ADVISORY"][index % 4];
    const tradeKey = transactionKey(accountId, securityId, `${tradeDate}-${index}`, acctTypeCode);
    const row: TransactionRow = withSizedPayload(
      {
        _id: transactionId(accountId, securityId, `${tradeDate}-${index}`, acctTypeCode),
        account_id: accountId,
        security_id: securityId,
        trade_date: tradeDate,
        trade_date_epoch: Date.parse(`${tradeDate}T00:00:00.000Z`),
        acct_type_code: acctTypeCode,
        transaction_type: index % 2 === 0 ? "BUY" : "SELL",
        quantity: Math.round((random() * 1000 + 1) * 10000) / 10000,
        amount: Math.round((random() * 250_000 + 10) * 100) / 100
      },
      options.payloadBytes
    );

    return `"JSON.SET" "${tradeKey}" "$" "${escapeMonitorArg(JSON.stringify(row))}"`;
  });
}

function readInt(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function escapeMonitorArg(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function mulberry32(seed: number): () => number {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
