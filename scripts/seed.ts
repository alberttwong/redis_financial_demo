import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { rebuildAccountSnapshot } from "../src/lib/account-snapshots";
import { createIndexes, dropIndexes, waitForIndexesReady } from "../src/lib/indexes";
import { jsonMGet, jsonSetCommand } from "../src/lib/json";
import { getSeedConfig, type SeedConfig } from "../src/lib/config";
import {
  makeAccount,
  makePosition,
  makeSecurity,
  makeTransactionForSequence,
  seedFaker
} from "../src/lib/data";
import { accountKey, positionKey, securityKey, transactionKey } from "../src/lib/keys";
import {
  resolveSeedPartition,
  transactionsForAccount,
  transactionsInPartition,
  type SeedPartition
} from "../src/lib/seed-partition";
import { closeRedisClient, executeRedisPipeline, getRedisClient, sendRedisCommand } from "../src/lib/redis";
import type { AccountRow, SecurityRow } from "../src/lib/types";

type SeedTarget =
  | "accounts"
  | "securities"
  | "positions"
  | "transactions"
  | "snapshots"
  | "indexes"
  | "prepare"
  | "partition"
  | "finalize"
  | "clear-checkpoints"
  | "all";
type AccountRef = Pick<AccountRow, "account_id">;
type SecurityRef = Pick<SecurityRow, "security_id" | "security_no">;
type RedisRow = { key: string; value: unknown };
type CheckpointTarget = "accounts" | "securities" | "positions" | "transactions";
type CheckpointSpec = {
  target: CheckpointTarget;
  partitionIndex: number | null;
  total: number;
};
type BatchWriteResult = { count: number; nextOffset: number };
type BatchWriteState = {
  label: string;
  total: number;
  concurrency: number;
  checkpoint?: CheckpointSpec;
  pending: Array<Promise<BatchWriteResult>>;
  completed: number;
  lastProgressAt: number;
};
type StoredCheckpoint = {
  profile: string;
  target: CheckpointTarget;
  partition_index: number | null;
  next_offset: number;
  total: number;
  updated_at: string;
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

async function writeGeneratedRows(
  label: string,
  checkpoint: CheckpointSpec,
  makeRow: (offset: number) => RedisRow
): Promise<number> {
  const config = getSeedConfig();
  const startOffset = await loadCheckpoint(checkpoint);
  const state = createBatchWriteState(label, checkpoint.total, config.writeConcurrency, startOffset, checkpoint);
  const batch: RedisRow[] = [];

  logResume(label, startOffset, checkpoint.total);
  for (let offset = startOffset; offset < checkpoint.total; offset += 1) {
    batch.push(makeRow(offset));
    if (batch.length >= config.batchSize) {
      await queueRows(state, batch.splice(0), offset + 1);
    }
  }

  if (batch.length > 0) await queueRows(state, batch.splice(0), checkpoint.total);
  return finishQueuedRows(state);
}

async function writeRows(rows: RedisRow[]): Promise<void> {
  const client = await getRedisClient();
  await executeRedisPipeline(
    client,
    rows.map((row) => jsonSetCommand(row.key, row.value))
  );
}

function createBatchWriteState(
  label: string,
  total: number,
  concurrency: number,
  completed = 0,
  checkpoint?: CheckpointSpec
): BatchWriteState {
  return {
    label,
    total,
    concurrency: Math.max(1, concurrency),
    checkpoint,
    pending: [],
    completed,
    lastProgressAt: performance.now()
  };
}

async function queueRows(state: BatchWriteState, batch: RedisRow[], nextOffset: number): Promise<void> {
  if (batch.length === 0) return;

  state.pending.push(writeRows(batch).then(() => ({ count: batch.length, nextOffset })));
  if (state.pending.length >= state.concurrency) await waitForOldestBatch(state);
}

async function finishQueuedRows(state: BatchWriteState): Promise<number> {
  while (state.pending.length > 0) await waitForOldestBatch(state);
  return state.completed;
}

async function waitForOldestBatch(state: BatchWriteState): Promise<void> {
  const write = state.pending.shift();
  if (!write) return;
  const result = await write;
  state.completed += result.count;
  if (state.checkpoint) await saveCheckpoint(state.checkpoint, result.nextOffset);
  state.lastProgressAt = logWriteProgress(state.label, state.completed, state.total, state.lastProgressAt);
}

function logResume(label: string, startOffset: number, total: number): void {
  const config = getSeedConfig();
  console.log(
    `${label}: completing ${total} rows in batches of ${config.batchSize} with concurrency ${config.writeConcurrency}`
  );
  if (startOffset > 0) console.log(`${label}: resuming at ${startOffset}/${total}`);
}

function logWriteProgress(label: string, completed: number, total: number, lastProgressAt: number): number {
  const now = performance.now();
  if (completed === total || now - lastProgressAt >= 5000) {
    console.log(`${label}: completed ${completed}/${total}`);
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

function accountRef(index: number): AccountRef {
  return { account_id: accountId(index) };
}

function makeSecurityRefs(): SecurityRef[] {
  const config = getSeedConfig();
  return Array.from({ length: config.securityCount }, (_, index) => ({
    security_id: securityId(index),
    security_no: securityNo(index)
  }));
}

function currentPartition(): SeedPartition {
  const config = getSeedConfig();
  return resolveSeedPartition(config.accountCount, config.partitionIndex, config.partitionCount);
}

async function seedAccounts(): Promise<number> {
  const config = getSeedConfig();
  const partition = currentPartition();
  return writeGeneratedRows(
    partitionLabel("accounts", partition),
    { target: "accounts", partitionIndex: partition.index, total: partition.accountCount },
    (offset) => {
      const accountIndex = partition.startAccountIndex + offset;
      seedFaker(deterministicFakerSeed(config.randomSeed, accountIndex));
      const account = makeAccount(accountIndex);
      return { key: accountKey(account.account_id), value: account };
    }
  );
}

async function seedSecurities(): Promise<number> {
  const config = getSeedConfig();
  return writeGeneratedRows(
    "securities",
    { target: "securities", partitionIndex: null, total: config.securityCount },
    (securityIndex) => {
      seedFaker(deterministicFakerSeed(config.randomSeed ^ 0x5f3759df, securityIndex));
      const security = makeSecurity(securityIndex, config.securityBytes);
      return { key: securityKey(security.security_id), value: security };
    }
  );
}

async function seedPositions(): Promise<number> {
  const config = getSeedConfig();
  const partition = currentPartition();
  const securities = makeSecurityRefs();
  const total = partition.accountCount * config.positionsPerAccount;

  return writeGeneratedRows(
    partitionLabel("positions", partition),
    { target: "positions", partitionIndex: partition.index, total },
    (localOffset) => {
      const accountOffset = Math.floor(localOffset / config.positionsPerAccount);
      const positionOffset = localOffset % config.positionsPerAccount;
      const accountIndex = partition.startAccountIndex + accountOffset;
      const account = accountRef(accountIndex);
      const security = securities[(accountIndex * config.positionsPerAccount + positionOffset) % securities.length];
      const rowIndex = accountIndex * config.positionsPerAccount + positionOffset;
      const position = makePosition(account, security, config.positionBytes, {
        randomSeed: config.randomSeed,
        rowIndex,
        asOfDate: config.asOfDate
      });
      return {
        key: positionKey(position.account_id, position.security_no, position.acct_type_code),
        value: position
      };
    }
  );
}

async function seedTransactions(): Promise<number> {
  const config = getSeedConfig();
  const partition = currentPartition();
  const securities = makeSecurityRefs();
  const total = transactionsInPartition(config.transactionCount, config.accountCount, partition);
  const checkpoint = { target: "transactions", partitionIndex: partition.index, total } as const;
  const startOffset = await loadCheckpoint(checkpoint);
  const state = createBatchWriteState(
    partitionLabel("transactions", partition),
    total,
    config.writeConcurrency,
    startOffset,
    checkpoint
  );
  const batch: RedisRow[] = [];
  let localOffset = 0;

  logResume(state.label, startOffset, total);
  for (let accountIndex = partition.startAccountIndex; accountIndex < partition.endAccountIndex; accountIndex += 1) {
    const accountTransactionCount = transactionsForAccount(config.transactionCount, config.accountCount, accountIndex);
    const accountEndOffset = localOffset + accountTransactionCount;
    if (startOffset >= accountEndOffset) {
      localOffset = accountEndOffset;
      continue;
    }

    const account = accountRef(accountIndex);
    const startSequence = Math.max(0, startOffset - localOffset);
    localOffset += startSequence;
    for (let sequence = startSequence; sequence < accountTransactionCount; sequence += 1) {
      const security = securities[(accountIndex * 131 + sequence) % securities.length];
      const rowIndex = sequence * config.accountCount + accountIndex;
      const transaction = makeTransactionForSequence(
        account,
        security,
        sequence,
        securities.length,
        config.transactionBytes,
        { randomSeed: config.randomSeed, rowIndex }
      );
      batch.push({
        key: transactionKey(
          transaction.account_id,
          transaction.security_no,
          transaction.acct_type_code,
          transaction.transaction_id
        ),
        value: transaction
      });
      localOffset += 1;

      if (batch.length >= config.batchSize) await queueRows(state, batch.splice(0), localOffset);
    }
  }

  if (batch.length > 0) await queueRows(state, batch.splice(0), total);
  return finishQueuedRows(state);
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

  console.log(`snapshots: loaded ${lookup.size} securities for snapshot joins`);
  return lookup;
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<boolean>
): Promise<number> {
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
        console.log(`snapshots: processed ${completed}/${items.length}, wrote ${truthy}`);
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
  const client = await getRedisClient();
  const accounts = Array.from({ length: config.accountCount }, (_, index) => accountRef(index));
  const securityByNo = await loadSecurityLookup();

  console.log(`snapshots: using concurrency ${config.snapshotConcurrency}`);
  return mapWithConcurrency(accounts, config.snapshotConcurrency, async (account) =>
    Boolean(
      await rebuildAccountSnapshot(client, account.account_id, {
        securityByNo,
        transactionLimit: Math.min(config.transactionCount, 200)
      })
    )
  );
}

async function ensureIndexes(): Promise<void> {
  const config = getSeedConfig();
  const client = await getRedisClient();
  const results = await createIndexes(client);
  for (const result of results) console.log("indexes: " + result);

  const ready = await waitForIndexesReady(client, config.indexTimeoutMs);
  for (const result of ready) console.log("indexes: " + result);
}

async function dropExistingIndexes(): Promise<void> {
  const client = await getRedisClient();
  const results = await dropIndexes(client);
  for (const result of results) console.log("indexes: " + result);
}

async function runSeedTask(name: string, task: () => Promise<number>): Promise<number> {
  return timeTask(name, async () => {
    const count = await task();
    console.log(`${name}: completed ${count}`);
    return count;
  });
}

async function prepareSeed(): Promise<void> {
  const config = getSeedConfig();
  if (config.resetCheckpoints) await timeTask("reset-checkpoints", clearSeedCheckpoints);
  if (config.dropIndexesBeforeLoad) await timeTask("drop-indexes", dropExistingIndexes);
  await runSeedTask("securities", seedSecurities);
}

async function seedCurrentPartition(): Promise<void> {
  const partition = currentPartition();
  console.log(
    `partition ${partition.index + 1}/${partition.count}: accounts ${partition.startAccountIndex + 1}-${partition.endAccountIndex}`
  );
  await runSeedTask(partitionLabel("accounts", partition), seedAccounts);
  await runSeedTask(partitionLabel("positions", partition), seedPositions);
  await runSeedTask(partitionLabel("transactions", partition), seedTransactions);
}

async function finalizeSeed(): Promise<void> {
  const config = getSeedConfig();
  await timeTask("indexes", ensureIndexes);
  if (config.skipSnapshots) {
    console.log("snapshots: skipped because SEED_SKIP_SNAPSHOTS=true");
  } else {
    await runSeedTask("snapshots", seedSnapshots);
  }
  await timeTask("clear-checkpoints", clearSeedCheckpoints);
}

async function loadCheckpoint(spec: CheckpointSpec): Promise<number> {
  const config = getSeedConfig();
  if (!config.resume) return 0;
  const client = await getRedisClient();
  const raw = await sendRedisCommand<string | null>(client, ["GET", checkpointKey(config, spec)]);
  if (!raw) return 0;

  const checkpoint = JSON.parse(raw) as StoredCheckpoint;
  const profile = seedProfile(config);
  if (
    checkpoint.profile !== profile ||
    checkpoint.target !== spec.target ||
    checkpoint.partition_index !== spec.partitionIndex ||
    checkpoint.total !== spec.total ||
    checkpoint.next_offset < 0 ||
    checkpoint.next_offset > spec.total
  ) {
    throw new Error(`Invalid seed checkpoint for ${spec.target}; rerun prepare with SEED_RESET_CHECKPOINTS=true`);
  }
  return checkpoint.next_offset;
}

async function saveCheckpoint(spec: CheckpointSpec, nextOffset: number): Promise<void> {
  const config = getSeedConfig();
  if (!config.resume) return;
  const checkpoint: StoredCheckpoint = {
    profile: seedProfile(config),
    target: spec.target,
    partition_index: spec.partitionIndex,
    next_offset: nextOffset,
    total: spec.total,
    updated_at: new Date().toISOString()
  };
  const client = await getRedisClient();
  await sendRedisCommand(client, ["SET", checkpointKey(config, spec), JSON.stringify(checkpoint)]);
}

async function clearSeedCheckpoints(): Promise<void> {
  const config = getSeedConfig();
  const commands: string[][] = [
    ["DEL", checkpointKey(config, { target: "securities", partitionIndex: null, total: config.securityCount })]
  ];
  for (let partitionIndex = 0; partitionIndex < config.partitionCount; partitionIndex += 1) {
    const partition = resolveSeedPartition(config.accountCount, partitionIndex, config.partitionCount);
    commands.push(
      ["DEL", checkpointKey(config, { target: "accounts", partitionIndex, total: partition.accountCount })],
      [
        "DEL",
        checkpointKey(config, {
          target: "positions",
          partitionIndex,
          total: partition.accountCount * config.positionsPerAccount
        })
      ],
      [
        "DEL",
        checkpointKey(config, {
          target: "transactions",
          partitionIndex,
          total: transactionsInPartition(config.transactionCount, config.accountCount, partition)
        })
      ]
    );
  }
  const client = await getRedisClient();
  await executeRedisPipeline(client, commands);
}

function checkpointKey(config: SeedConfig, spec: CheckpointSpec): string {
  const owner = spec.partitionIndex === null ? "coordinator" : `partition-${spec.partitionIndex}`;
  return `seed-checkpoint:{${owner}}:${seedProfile(config)}:${spec.target}`;
}

function seedProfile(config: SeedConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        accounts: config.accountCount,
        securities: config.securityCount,
        positions_per_account: config.positionsPerAccount,
        transactions: config.transactionCount,
        security_bytes: config.securityBytes,
        position_bytes: config.positionBytes,
        transaction_bytes: config.transactionBytes,
        random_seed: config.randomSeed,
        as_of_date: config.asOfDate,
        partitions: config.partitionCount
      })
    )
    .digest("hex")
    .slice(0, 20);
}

function deterministicFakerSeed(randomSeed: number, rowIndex: number): number {
  return (randomSeed + Math.imul(rowIndex + 1, 1_000_003)) >>> 0;
}

function partitionLabel(target: string, partition: SeedPartition): string {
  return `${target}[${partition.index + 1}/${partition.count}]`;
}

async function main(): Promise<void> {
  const target = (process.argv[2] ?? "all") as SeedTarget;
  const config = getSeedConfig();
  seedFaker(config.randomSeed);
  await getRedisClient();

  if (target === "all") {
    if (config.partitionCount !== 1) {
      throw new Error("seed target all requires SEED_PARTITION_COUNT=1; use the distributed seed coordinator");
    }
    await prepareSeed();
    await seedCurrentPartition();
    await finalizeSeed();
    return;
  }
  if (target === "prepare") return prepareSeed();
  if (target === "partition") return seedCurrentPartition();
  if (target === "finalize") return finalizeSeed();
  if (target === "indexes") return timeTask("indexes", ensureIndexes);
  if (target === "clear-checkpoints") return timeTask("clear-checkpoints", clearSeedCheckpoints);
  if (target === "snapshots") {
    await timeTask("indexes", ensureIndexes);
    await runSeedTask("snapshots", seedSnapshots);
    return;
  }

  const taskByTarget: Partial<Record<SeedTarget, () => Promise<number>>> = {
    accounts: seedAccounts,
    securities: seedSecurities,
    positions: seedPositions,
    transactions: seedTransactions
  };
  const task = taskByTarget[target];
  if (!task) throw new Error(`Unknown seed target ${target}`);
  await runSeedTask(target, task);
  await timeTask("indexes", ensureIndexes);
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
