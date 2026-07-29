import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  loadBenchmarkSamplePool,
  type SecuritySample,
  type TransactionSample
} from "../src/lib/benchmark-samples";
import { jsonMGetFields, jsonSet } from "../src/lib/json";
import {
  securityByNoViewKey,
  securityKey,
  transactionsByAccountSecurityViewKey,
  transactionsBySecurityViewKey
} from "../src/lib/keys";
import { SECURITY_PROJECTION_FIELDS } from "../src/lib/projections";
import { transactionsSearch } from "../src/lib/queries";
import {
  disconnectRedisPool,
  getRedisClient,
  type RedisConnection
} from "../src/lib/redis";
import type { SecurityProjection, TransactionProjection } from "../src/lib/types";

type MaterializedTransactionView = {
  generated_at: string;
  source_pattern: "transactionsBySecurity" | "transactionsByAccountSecurity";
  transactions: TransactionProjection[];
};

type MaterializationCounts = {
  security_by_no_direct: number;
  transactions_by_security_materialized: number;
  transactions_by_account_security_materialized: number;
};

async function main(): Promise<void> {
  const samplePoolSize = readPositiveInteger(
    "QUERY_VIEW_SAMPLE_POOL_SIZE",
    readPositiveInteger("QUERY_SAMPLE_POOL_SIZE", 1_000)
  );
  const transactionLimit = Math.min(
    200,
    readPositiveInteger("QUERY_VIEW_TRANSACTION_LIMIT", 100)
  );
  const concurrency = readPositiveInteger("QUERY_VIEW_BUILD_CONCURRENCY", 4);
  const outputDirectory =
    process.env.LOAD_TEST_OUTPUT_DIR ?? "memtier-output/query-comparison";
  const startedAt = performance.now();
  const client = await getRedisClient();
  const pool = await loadBenchmarkSamplePool(client, samplePoolSize);
  const securities = uniqueSecurities([
    ...pool.securities,
    ...pool.transactions.map(({ security_id, security_no }) => ({
      security_id,
      security_no
    }))
  ]);
  const accountSecurities = uniqueAccountSecurities(pool.transactions);

  console.log(
    `Materializing comparison views for ${securities.length} securities and ${accountSecurities.length} account/security pairs with concurrency ${concurrency}`
  );

  const securityByNoCount = await materializeSecurityByNoViews(
    client,
    securities,
    concurrency
  );
  const transactionsBySecurityCount = await mapWithConcurrency(
    securities,
    concurrency,
    async (security) => {
      const result = await transactionsSearch(
        { client },
        { securityId: security.security_id, limit: transactionLimit }
      );
      await jsonSet(
        client,
        transactionsBySecurityViewKey(security.security_id),
        transactionView("transactionsBySecurity", result.data)
      );
    }
  );
  const transactionsByAccountSecurityCount = await mapWithConcurrency(
    accountSecurities,
    concurrency,
    async (sample) => {
      const result = await transactionsSearch(
        { client },
        {
          accountId: sample.account_id,
          securityId: sample.security_id,
          limit: transactionLimit
        }
      );
      await jsonSet(
        client,
        transactionsByAccountSecurityViewKey(
          sample.account_id,
          sample.security_id
        ),
        transactionView("transactionsByAccountSecurity", result.data)
      );
    }
  );

  const counts: MaterializationCounts = {
    security_by_no_direct: securityByNoCount,
    transactions_by_security_materialized: transactionsBySecurityCount,
    transactions_by_account_security_materialized:
      transactionsByAccountSecurityCount
  };
  const manifest = {
    experiment: "query-comparison-materialization",
    generated_at: new Date().toISOString(),
    sample_pool_size: samplePoolSize,
    transaction_limit: transactionLimit,
    build_concurrency: concurrency,
    elapsed_seconds: round((performance.now() - startedAt) / 1_000),
    counts
  };
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = `${outputDirectory}/comparison-view-materialization.json`;
  const samplePoolPath = `${outputDirectory}/comparison-sample-pool.json`;
  await Promise.all([
    writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(samplePoolPath, `${JSON.stringify(pool, null, 2)}\n`)
  ]);
  console.log(JSON.stringify(manifest, null, 2));
  console.log(`Wrote ${outputPath}`);
  console.log(`Wrote ${samplePoolPath}`);
}

async function materializeSecurityByNoViews(
  client: RedisConnection,
  securities: SecuritySample[],
  concurrency: number
): Promise<number> {
  const projections = await jsonMGetFields<SecurityProjection>(
    client,
    securities.map((security) => securityKey(security.security_id)),
    SECURITY_PROJECTION_FIELDS
  );
  const missingIndex = projections.findIndex((projection) => !projection);
  if (missingIndex >= 0) {
    throw new Error(
      `Security ${securities[missingIndex].security_id} is missing while building comparison views`
    );
  }

  return mapWithConcurrency(
    projections as SecurityProjection[],
    concurrency,
    async (security) => {
      await jsonSet(client, securityByNoViewKey(security.security_no), security);
    }
  );
}

function transactionView(
  sourcePattern: MaterializedTransactionView["source_pattern"],
  transactions: TransactionProjection[]
): MaterializedTransactionView {
  return {
    generated_at: new Date().toISOString(),
    source_pattern: sourcePattern,
    transactions
  };
}

function uniqueSecurities(securities: SecuritySample[]): SecuritySample[] {
  return [
    ...new Map(
      securities.map((security) => [security.security_id, security])
    ).values()
  ];
}

function uniqueAccountSecurities(
  transactions: TransactionSample[]
): TransactionSample[] {
  return [
    ...new Map(
      transactions.map((transaction) => [
        `${transaction.account_id}\u0000${transaction.security_id}`,
        transaction
      ])
    ).values()
  ];
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>
): Promise<number> {
  let nextIndex = 0;
  let completed = 0;
  let lastProgressAt = performance.now();

  async function runWorker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(values[index]);
      completed += 1;
      const now = performance.now();
      if (completed === values.length || now - lastProgressAt >= 5_000) {
        console.log(`Materialized ${completed}/${values.length} views`);
        lastProgressAt = now;
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(1, values.length)) },
      () => runWorker()
    )
  );
  return completed;
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(disconnectRedisPool);
