import { faker } from "@faker-js/faker";
import { performance } from "node:perf_hooks";
import { createIndexes, dropIndexes } from "../src/lib/indexes";
import { jsonGet, jsonMGet, jsonSet, jsonSetCommand } from "../src/lib/json";
import { getSeedConfig } from "../src/lib/config";
import {
  makeAccount,
  makePosition,
  makeSecurity,
  makeTransactionForSequence,
  seedFaker
} from "../src/lib/data";
import { accountKey, securityKey, snapshotKey } from "../src/lib/keys";
import { positionsByAccount, transactionsSearch } from "../src/lib/queries";
import { closeRedisClient, getRedisClient } from "../src/lib/redis";
import type { AccountRow, AccountSnapshot, PositionRow, SecurityRow, TransactionRow } from "../src/lib/types";

type SeedTarget = "accounts" | "securities" | "positions" | "transactions" | "snapshots" | "all";
type AccountRef = Pick<AccountRow, "account_id">;
type SecurityRef = Pick<SecurityRow, "security_id" | "security_no">;
type SeedTask = [SeedTarget, () => Promise<number>];
type RedisRow = { key: string; value: unknown };
type BatchWriteState = {
  label: string;
  total: number;
  concurrency: number;
  pending: Array<Promise<number>>;
  written: number;
  lastProgressAt: number;
};

function formatDuration(ms: number): string {
  if (ms < 1000) return Math.round(ms) + "ms";
  return (ms / 1000).toFixed(1) + "s";
}

async function timeTask<T>(name: string, task: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  console.log(name + ": started");
  try {
    const result = await task();
    console.log(name + ": finished in " + formatDuration(performance.now() - startedAt));
    return result;
  } catch (error) {
    console.error(name + ": failed after " + formatDuration(performance.now() - startedAt));
    throw error;
  }
}

async function writeBatch(label: string, rows: RedisRow[], batchSize = getSeedConfig().batchSize): Promise<number> {
  const config = getSeedConfig();
  const state = createBatchWriteState(label, rows.length, config.writeConcurrency);

  console.log(label + ": writing " + rows.length + " rows in batches of " + batchSize + " with concurrency " + state.concurrency);
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    await queueRows(state, rows.slice(offset, offset + batchSize));
  }

  return finishQueuedRows(state);
}

async function writeRows(rows: RedisRow[]): Promise<void> {
  const client = await getRedisClient();
  const pipeline = client.multi();
  for (const row of rows) {
    pipeline.addCommand(jsonSetCommand(row.key, row.value));
  }
  await pipeline.execAsPipeline();
}

function createBatchWriteState(label: string, total: number, concurrency: number): BatchWriteState {
  return {
    label,
    total,
    concurrency: Math.max(1, concurrency),
    pending: [],
    written: 0,
    lastProgressAt: performance.now()
  };
}

async function queueRows(state: BatchWriteState, batch: RedisRow[]): Promise<void> {
  if (batch.length === 0) return;

  state.pending.push(writeRows(batch).then(() => batch.length));
  if (state.pending.length >= state.concurrency) {
    await waitForOldestBatch(state);
  }
}

async function finishQueuedRows(state: BatchWriteState): Promise<number> {
  while (state.pending.length > 0) {
    await waitForOldestBatch(state);
  }
  return state.written;
}

async function waitForOldestBatch(state: BatchWriteState): Promise<void> {
  const write = state.pending.shift();
  if (!write) return;
  state.written += await write;
  state.lastProgressAt = logWriteProgress(state.label, state.written, state.total, state.lastProgressAt);
}

function logWriteProgress(label: string, written: number, total: number, lastProgressAt: number): number {
  const now = performance.now();
  if (written === total || now - lastProgressAt >= 5000) {
    console.log(label + ": wrote " + written + "/" + total);
    return now;
  }
  return lastProgressAt;
}

function accountId(index: number): string {
  return "A" + String(index + 1).padStart(8, "0");
}

function securityId(index: number): string {
  return "SEC" + String(index + 1).padStart(8, "0");
}

function securityNo(index: number): string {
  return "SPX" + String(index + 1).padStart(6, "0");
}

function makeAccountRefs(): AccountRef[] {
  const config = getSeedConfig();
  return Array.from({ length: config.accountCount }, (_, index) => ({ account_id: accountId(index) }));
}

function makeSecurityRefs(): SecurityRef[] {
  const config = getSeedConfig();
  return Array.from({ length: config.securityCount }, (_, index) => ({
    security_id: securityId(index),
    security_no: securityNo(index)
  }));
}

function makeAccounts(): AccountRow[] {
  const config = getSeedConfig();
  return Array.from({ length: config.accountCount }, (_, index) => makeAccount(index));
}

function makeSecurities(): SecurityRow[] {
  const config = getSeedConfig();
  return Array.from({ length: config.securityCount }, (_, index) => makeSecurity(index, config.securityBytes));
}

async function seedAccounts(): Promise<number> {
  const accounts = makeAccounts();
  return writeBatch("accounts", accounts.map((account) => ({ key: accountKey(account.account_id), value: account })));
}

async function seedSecurities(): Promise<number> {
  const securities = makeSecurities();
  return writeBatch("securities", securities.map((security) => ({ key: securityKey(security.security_id), value: security })));
}

async function seedPositions(): Promise<number> {
  const config = getSeedConfig();
  const accounts = makeAccountRefs();
  const securities = makeSecurityRefs();
  const total = accounts.length * config.positionsPerAccount;
  const batch: RedisRow[] = [];
  const state = createBatchWriteState("positions", total, config.writeConcurrency);
  let written = 0;

  console.log("positions: writing " + total + " rows in batches of " + config.batchSize + " with concurrency " + state.concurrency);
  for (const [accountIndex, account] of accounts.entries()) {
    for (let offset = 0; offset < config.positionsPerAccount; offset += 1) {
      const security = securities[(accountIndex * config.positionsPerAccount + offset) % securities.length];
      const position = makePosition(account, security, config.positionBytes);
      batch.push({
        key: "pos:" + position.account_id + ":" + position.security_no + ":" + position.acct_type_code,
        value: position
      });

      if (batch.length >= config.batchSize) {
        await queueRows(state, batch.splice(0));
      }
    }
  }

  if (batch.length > 0) {
    await queueRows(state, batch.splice(0));
  }

  written = await finishQueuedRows(state);
  return written;
}

async function seedTransactions(): Promise<number> {
  const config = getSeedConfig();
  const accounts = makeAccountRefs();
  const securities = makeSecurityRefs();
  const batch: RedisRow[] = [];
  const state = createBatchWriteState("transactions", config.transactionCount, config.writeConcurrency);
  let written = 0;

  console.log("transactions: writing " + config.transactionCount + " rows in batches of " + config.batchSize + " with concurrency " + state.concurrency);
  for (let index = 0; index < config.transactionCount; index += 1) {
    const accountIndex = index % accounts.length;
    const sequence = Math.floor(index / accounts.length);
    const account = accounts[accountIndex];
    const security = securities[(accountIndex * 131 + sequence) % securities.length];
    const transaction = makeTransactionForSequence(account, security, sequence, securities.length, config.transactionBytes);
    const key = "txn:" + transaction.account_id + ":" + transaction.security_id + ":" + transaction.trade_date + ":" + transaction.acct_type_code;
    batch.push({ key, value: transaction });

    if (batch.length >= config.batchSize) {
      await queueRows(state, batch.splice(0));
    }
  }

  if (batch.length > 0) {
    await queueRows(state, batch.splice(0));
  }

  written = await finishQueuedRows(state);
  return written;
}

async function loadSecurityLookup(): Promise<Map<string, Omit<SecurityRow, "payload">>> {
  const client = await getRedisClient();
  const refs = makeSecurityRefs();
  const config = getSeedConfig();
  const lookup = new Map<string, Omit<SecurityRow, "payload">>();

  for (let offset = 0; offset < refs.length; offset += config.batchSize) {
    const batch = refs.slice(offset, offset + config.batchSize);
    const securities = await jsonMGet<SecurityRow>(client, batch.map((security) => securityKey(security.security_id)));
    for (const security of securities) {
      if (security) lookup.set(security.security_no, stripPayload(security));
    }
  }

  console.log("snapshots: loaded " + lookup.size + " securities for snapshot joins");
  return lookup;
}

async function buildSnapshot(account: AccountRef, securityByNo: Map<string, Omit<SecurityRow, "payload">>): Promise<boolean> {
  const client = await getRedisClient();
  const config = getSeedConfig();
  const existingAccount = await jsonGet<AccountRow>(client, accountKey(account.account_id));
  if (!existingAccount) return false;

  const [positions, transactions] = await Promise.all([
    positionsByAccount({ client }, account.account_id),
    transactionsSearch({ client }, { accountId: account.account_id, limit: Math.min(config.transactionCount, 200) })
  ]);

  const snapshotPositions: AccountSnapshot["positions"] = positions.data.map((position: PositionRow) => ({
    ...stripPayload(position),
    security: securityByNo.get(position.security_no)
  }));

  const snapshot: AccountSnapshot = {
    _id: account.account_id,
    account_id: account.account_id,
    generated_at: new Date().toISOString(),
    account: existingAccount,
    position_count: positions.result_count,
    transaction_count: transactions.result_count,
    total_market_value: positions.data.reduce((sum: number, position: PositionRow) => sum + position.market_value, 0),
    recent_transactions: transactions.data.slice(0, 200).map((transaction: TransactionRow) => stripPayload(transaction)),
    positions: snapshotPositions
  };

  await jsonSet(client, snapshotKey(account.account_id), snapshot);
  return true;
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<boolean>): Promise<number> {
  let nextIndex = 0;
  let completed = 0;
  let truthy = 0;
  let lastProgressAt = performance.now();

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      if (await worker(items[index], index)) truthy += 1;
      completed += 1;

      const now = performance.now();
      if (completed === items.length || now - lastProgressAt >= 5000) {
        console.log("snapshots: processed " + completed + "/" + items.length + ", wrote " + truthy);
        lastProgressAt = now;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker());
  await Promise.all(workers);
  return truthy;
}

async function seedSnapshots(): Promise<number> {
  const config = getSeedConfig();
  const accounts = makeAccountRefs();
  const securityByNo = await loadSecurityLookup();

  console.log("snapshots: using concurrency " + config.snapshotConcurrency);
  return mapWithConcurrency(accounts, config.snapshotConcurrency, (account) => buildSnapshot(account, securityByNo));
}

async function ensureIndexes(): Promise<void> {
  const client = await getRedisClient();
  const results = await createIndexes(client);
  for (const result of results) console.log("indexes: " + result);
}

async function dropExistingIndexes(): Promise<void> {
  const client = await getRedisClient();
  const results = await dropIndexes(client);
  for (const result of results) console.log("indexes: " + result);
}

async function runSeedTask(name: SeedTarget, task: () => Promise<number>): Promise<number> {
  return timeTask(name, async () => {
    const count = await task();
    console.log(name + ": wrote " + count);
    return count;
  });
}

async function main() {
  const target = (process.argv[2] ?? "all") as SeedTarget;
  const config = getSeedConfig();
  seedFaker(config.randomSeed);
  await getRedisClient();

  const baseTasks: SeedTask[] = [
    ["accounts", seedAccounts],
    ["securities", seedSecurities],
    ["positions", seedPositions],
    ["transactions", seedTransactions]
  ];

  if (target === "all") {
    if (config.dropIndexesBeforeLoad) {
      await timeTask("drop-indexes", dropExistingIndexes);
    }

    for (const [name, task] of baseTasks) {
      await runSeedTask(name, task);
    }

    await timeTask("indexes", ensureIndexes);

    if (config.skipSnapshots) {
      console.log("snapshots: skipped because SEED_SKIP_SNAPSHOTS=true");
    } else {
      await runSeedTask("snapshots", seedSnapshots);
    }
    return;
  }

  const task = [...baseTasks, ["snapshots", seedSnapshots] as SeedTask].find(([name]) => name === target);
  if (!task) {
    throw new Error("Unknown seed target " + target);
  }

  if (target === "snapshots") {
    await timeTask("indexes", ensureIndexes);
    await runSeedTask("snapshots", seedSnapshots);
  } else {
    await runSeedTask(task[0], task[1]);
    await timeTask("indexes", ensureIndexes);
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
