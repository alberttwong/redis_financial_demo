import { mkdir, writeFile } from "node:fs/promises";
import { getSeedConfig } from "../src/lib/config";
import { accountKey, snapshotKey, transactionKey, transactionId } from "../src/lib/keys";
import { withSizedPayload } from "../src/lib/payload";
import { closeRedisClient, getRedisClient } from "../src/lib/redis";
import { searchKeys } from "../src/lib/search";
import type { TransactionRow } from "../src/lib/types";

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
  await writeFile("monitor-input/transactions.txt", transactionLines.join("\n") + "\n");
  await writeFile("monitor-input/trade-writes.txt", tradeWriteLines.join("\n") + "\n");
  await writeFile("monitor-input/mixed.txt", mixedLines.join("\n") + "\n");

  console.log("Wrote monitor-input/account-reads.txt");
  console.log("Wrote monitor-input/snapshot-reads.txt");
  console.log("Wrote monitor-input/transactions.txt");
  console.log("Wrote monitor-input/trade-writes.txt");
  console.log("Wrote monitor-input/mixed.txt");
}

async function makeTransactionLines(accountCount: number): Promise<string[]> {
  if (!process.env.REDIS_URL) {
    return fallbackTransactionSearchLines(accountCount);
  }

  try {
    const client = await getRedisClient();
    const keys: string[] = [];
    const pageSize = 1000;
    const maxKeys = Number.parseInt(process.env.MEMTIER_TRANSACTION_KEYS ?? "10000", 10);

    for (let offset = 0; keys.length < maxKeys; offset += pageSize) {
      const page = await searchKeys(client, "idx:transactions", "*", {
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
  } catch (error) {
    await closeRedisClient().catch(() => undefined);
    console.warn(
      `Could not load live transaction keys from Redis; falling back to indexed transaction searches. ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return fallbackTransactionSearchLines(accountCount);
}

function fallbackTransactionSearchLines(accountCount: number): string[] {
  return Array.from({ length: Math.min(accountCount, 1000) }, (_, index) => {
    const accountId = `A${String((index % accountCount) + 1).padStart(8, "0")}`;
    return `"FT.SEARCH" "idx:transactions" "@account_id:{${accountId}}" "NOCONTENT" "LIMIT" "0" "20" "DIALECT" "2"`;
  });
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
