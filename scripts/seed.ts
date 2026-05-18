import { faker } from "@faker-js/faker";
import { createIndexes } from "../src/lib/indexes";
import { jsonGet, jsonSet } from "../src/lib/json";
import { getSeedConfig } from "../src/lib/config";
import {
  makeAccount,
  makePosition,
  makeSecurity,
  makeTransaction,
  seedFaker
} from "../src/lib/data";
import { accountKey, snapshotKey } from "../src/lib/keys";
import {
  accountActivityJoin,
  accountPortfolioJoin,
  positionsByAccount,
  transactionsSearch
} from "../src/lib/queries";
import { closeRedisClient, getRedisClient } from "../src/lib/redis";
import type { AccountRow, AccountSnapshot, SecurityRow } from "../src/lib/types";

type SeedTarget = "accounts" | "securities" | "positions" | "transactions" | "snapshots" | "all";

async function writeBatch(rows: Array<{ key: string; value: unknown }>, batchSize = 500): Promise<number> {
  const client = await getRedisClient();
  let written = 0;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    await Promise.all(batch.map((row) => jsonSet(client, row.key, row.value)));
    written += batch.length;
  }
  return written;
}

function makeAccounts(): AccountRow[] {
  const config = getSeedConfig();
  return Array.from({ length: config.accountCount }, (_, index) => makeAccount(index, config.accountBytes));
}

function makeSecurities(): SecurityRow[] {
  const config = getSeedConfig();
  return Array.from({ length: config.securityCount }, (_, index) => makeSecurity(index, config.securityBytes));
}

async function seedAccounts(): Promise<number> {
  const accounts = makeAccounts();
  return writeBatch(accounts.map((account) => ({ key: accountKey(account.account_id), value: account })));
}

async function seedSecurities(): Promise<number> {
  const securities = makeSecurities();
  return writeBatch(securities.map((security) => ({ key: `sec:${security.security_id}:info`, value: security })));
}

async function seedPositions(): Promise<number> {
  const config = getSeedConfig();
  const accounts = makeAccounts();
  const securities = makeSecurities();
  const rows = accounts.flatMap((account, accountIndex) =>
    Array.from({ length: config.positionsPerAccount }, (_, offset) => {
      const security = securities[(accountIndex * config.positionsPerAccount + offset) % securities.length];
      const position = makePosition(account, security, config.positionBytes);
      return {
        key: `pos:${position.account_id}:${position.security_no}:${position.acct_type_code}`,
        value: position
      };
    })
  );
  return writeBatch(rows);
}

async function seedTransactions(): Promise<number> {
  const config = getSeedConfig();
  const accounts = makeAccounts();
  const securities = makeSecurities();
  const rows: Array<{ key: string; value: unknown }> = [];
  const usedKeys = new Set<string>();
  let attempts = 0;

  while (rows.length < config.transactionCount && attempts < config.transactionCount * 5) {
    attempts += 1;
    const account = faker.helpers.arrayElement(accounts);
    const security = faker.helpers.arrayElement(securities);
    const transaction = makeTransaction(account, security, config.transactionBytes);
    const key = `txn:${transaction.account_id}:${transaction.security_id}:${transaction.trade_date}:${transaction.acct_type_code}`;
    if (usedKeys.has(key)) continue;
    usedKeys.add(key);
    rows.push({ key, value: transaction });
  }

  if (rows.length < config.transactionCount) {
    throw new Error(`Only generated ${rows.length} unique transactions after ${attempts} attempts.`);
  }

  return writeBatch(rows);
}

async function seedSnapshots(): Promise<number> {
  const client = await getRedisClient();
  const config = getSeedConfig();
  const accounts = makeAccounts();
  let written = 0;

  for (const account of accounts) {
    const existingAccount = await jsonGet<AccountRow>(client, accountKey(account.account_id));
    if (!existingAccount) continue;

    const portfolio = await accountPortfolioJoin({ client }, account.account_id);
    const activity = await accountActivityJoin({ client }, account.account_id);
    const positions = await positionsByAccount({ client }, account.account_id);
    const transactions = await transactionsSearch({ client }, { accountId: account.account_id, limit: Math.min(config.transactionCount, 100) });

    const snapshot: AccountSnapshot = {
      _id: account.account_id,
      account_id: account.account_id,
      generated_at: new Date().toISOString(),
      account: stripPayload(existingAccount),
      position_count: positions.result_count,
      transaction_count: transactions.result_count,
      total_market_value: positions.data.reduce((sum, position) => sum + position.market_value, 0),
      recent_transactions: transactions.data.slice(0, 25).map(stripPayload),
      positions: (portfolio.data as { positions?: AccountSnapshot["positions"] }).positions ?? []
    };

    await jsonSet(client, snapshotKey(account.account_id), snapshot);
    written += 1;
    void activity;
  }

  return written;
}

async function main() {
  const target = (process.argv[2] ?? "all") as SeedTarget;
  const config = getSeedConfig();
  seedFaker(config.randomSeed);
  const client = await getRedisClient();
  await createIndexes(client);

  const tasks: Array<[SeedTarget, () => Promise<number>]> = [
    ["accounts", seedAccounts],
    ["securities", seedSecurities],
    ["positions", seedPositions],
    ["transactions", seedTransactions],
    ["snapshots", seedSnapshots]
  ];

  for (const [name, task] of tasks) {
    if (target !== "all" && target !== name) continue;
    const count = await task();
    console.log(`${name}: wrote ${count}`);
  }
}

function stripPayload<T extends { payload?: string }>(row: T): Omit<T, "payload"> {
  const { payload: _payload, ...rest } = row;
  return rest;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedisClient();
  });
