import { performance } from "node:perf_hooks";
import { INDEXES } from "./indexes";
import { measure, roundMs } from "./timing";
import { jsonGet, jsonGetFields } from "./json";
import {
  accountKey,
  positionKey,
  securityKey,
  snapshotKey,
  transactionKey
} from "./keys";
import {
  POSITION_PROJECTION_FIELDS,
  SECURITY_PROJECTION_FIELDS,
  TRANSACTION_PROJECTION_FIELDS
} from "./projections";
import { searchProjected } from "./search";
import type { RedisConnection } from "./redis";
import { tagEquals } from "./tag";
import type {
  AccountRow,
  AccountSnapshot,
  PositionProjection,
  PositionRow,
  QueryResult,
  SecurityProjection,
  SecurityRow,
  Timings,
  TransactionProjection,
  TransactionRow
} from "./types";

type QueryContext = {
  client: RedisConnection;
  startedAt?: number;
};

function emptyTimings(): Timings {
  return {
    redis_ms: 0,
    search_ms: 0,
    hydrate_ms: 0,
    join_ms: 0,
    total_ms: 0
  };
}

function response<T>(
  startedAt: number,
  data: T,
  timing: Timings,
  resultCount: number,
  redisCommandCount: number,
  commands: string[]
): QueryResult<T> {
  return {
    data,
    timing: {
      ...timing,
      total_ms: roundMs(performance.now() - startedAt)
    },
    result_count: resultCount,
    redis_command_count: redisCommandCount,
    commands
  };
}

export async function accountById(ctx: QueryContext, accountId: string): Promise<QueryResult<AccountRow | null>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const { value, ms } = await measure(() => jsonGet<AccountRow>(ctx.client, accountKey(accountId)));
  timing.redis_ms = ms;
  return response(startedAt, value, timing, value ? 1 : 0, 1, [`JSON.GET ${accountKey(accountId)} $`]);
}

export async function securityById(ctx: QueryContext, securityId: string): Promise<QueryResult<SecurityRow | null>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const { value, ms } = await measure(() => jsonGet<SecurityRow>(ctx.client, securityKey(securityId)));
  timing.redis_ms = ms;
  return response(startedAt, value, timing, value ? 1 : 0, 1, [`JSON.GET ${securityKey(securityId)} $`]);
}

export async function securityByNo(
  ctx: QueryContext,
  securityNo: string
): Promise<QueryResult<SecurityProjection[]>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const query = tagEquals("security_no", securityNo);
  const search = await measure(() =>
    searchProjected<SecurityProjection>(ctx.client, INDEXES.securities, query, SECURITY_PROJECTION_FIELDS, {
      limit: 20
    })
  );
  timing.search_ms = search.ms;
  timing.redis_ms = search.ms;
  const data = search.value.rows;
  return response(startedAt, data, timing, data.length, 1, [
    `FT.SEARCH ${INDEXES.securities} "${query}" RETURN <projected-fields> LIMIT 0 20 DIALECT 2`
  ]);
}

export async function positionByComposite(
  ctx: QueryContext,
  accountId: string,
  securityNo: string,
  acctTypeCode: string
): Promise<QueryResult<PositionRow | null>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const key = positionKey(accountId, securityNo, acctTypeCode);
  const { value, ms } = await measure(() => jsonGet<PositionRow>(ctx.client, key));
  timing.redis_ms = ms;
  return response(startedAt, value, timing, value ? 1 : 0, 1, [`JSON.GET ${key} $`]);
}

export async function positionsByAccount(
  ctx: QueryContext,
  accountId: string
): Promise<QueryResult<PositionProjection[]>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const key = snapshotKey(accountId);
  type Projection = Pick<AccountSnapshot, "position_count" | "positions">;
  const projected = await measure(() =>
    jsonGetFields<Projection>(ctx.client, key, ["position_count", "positions"])
  );
  timing.redis_ms = projected.ms;
  if (projected.value && projected.value.positions.length !== projected.value.position_count) {
    throw new Error(
      `Account ${accountId} snapshot position_count ${projected.value.position_count} does not match positions length ${projected.value.positions.length}`
    );
  }
  const data = projected.value?.positions.map(withoutSecurity) ?? [];
  return response(startedAt, data, timing, data.length, 1, [
    `JSON.GET ${key} $.position_count $.positions`
  ]);
}

export async function positionsSearchByAccount(
  ctx: QueryContext,
  accountId: string
): Promise<QueryResult<PositionProjection[]>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const query = tagEquals("account_id", accountId);
  const search = await measure(() =>
    searchProjected<PositionProjection>(
      ctx.client,
      INDEXES.positions,
      query,
      POSITION_PROJECTION_FIELDS,
      { limit: 500, dialect: 4 }
    )
  );
  timing.search_ms = search.ms;
  timing.redis_ms = search.ms;
  const data = search.value.rows;
  return response(startedAt, data, timing, data.length, 1, [
    `FT.SEARCH ${INDEXES.positions} "${query}" RETURN <projected-fields> LIMIT 0 500 DIALECT 4`
  ]);
}

export async function transactionById(
  ctx: QueryContext,
  accountId: string,
  securityNo: string,
  acctTypeCode: string,
  transactionId: string
): Promise<QueryResult<TransactionRow | null>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const key = transactionKey(accountId, securityNo, acctTypeCode, transactionId);
  const { value, ms } = await measure(() => jsonGet<TransactionRow>(ctx.client, key));
  timing.redis_ms = ms;
  return response(startedAt, value, timing, value ? 1 : 0, 1, [`JSON.GET ${key} $`]);
}

export async function transactionsByComposite(
  ctx: QueryContext,
  accountId: string,
  securityId: string,
  tradeDate: string,
  acctTypeCode: string
): Promise<QueryResult<TransactionProjection[]>> {
  const tradeDateEpoch = Date.parse(`${tradeDate}T00:00:00.000Z`);
  if (!Number.isFinite(tradeDateEpoch)) {
    throw new Error("tradeDate must use YYYY-MM-DD format");
  }
  return transactionsSearch(ctx, { accountId, securityId, tradeDateEpoch, acctTypeCode, limit: 100 });
}

export async function transactionsSearch(
  ctx: QueryContext,
  filters: {
    accountId?: string;
    securityId?: string;
    tradeDateEpoch?: number;
    acctTypeCode?: string;
    limit?: number;
  }
): Promise<QueryResult<TransactionProjection[]>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const clauses = [
    filters.accountId ? tagEquals("account_id", filters.accountId) : "",
    filters.securityId ? tagEquals("security_id", filters.securityId) : "",
    filters.tradeDateEpoch !== undefined
      ? `@trade_date_epoch:[${filters.tradeDateEpoch} ${filters.tradeDateEpoch}]`
      : "",
    filters.acctTypeCode ? tagEquals("acct_type_code", filters.acctTypeCode) : ""
  ].filter(Boolean);
  const query = clauses.length ? clauses.join(" ") : "*";
  const limit = filters.limit ?? 100;
  const search = await measure(() =>
    searchProjected<TransactionProjection>(
      ctx.client,
      INDEXES.transactions,
      query,
      TRANSACTION_PROJECTION_FIELDS,
      {
        limit,
        dialect: 4,
        sortBy: {
          field: "trade_date_epoch",
          direction: "DESC",
          withoutCount: true
        }
      }
    )
  );
  timing.search_ms = search.ms;
  timing.redis_ms = search.ms;
  const data = search.value.rows;
  return response(startedAt, data, timing, data.length, 1, [
    `FT.SEARCH ${INDEXES.transactions} "${query}" RETURN <projected-fields> SORTBY trade_date_epoch DESC WITHOUTCOUNT LIMIT 0 ${limit} DIALECT 4`
  ]);
}

export async function transactionsByAccount(
  ctx: QueryContext,
  accountId: string,
  limit = 100
): Promise<QueryResult<TransactionProjection[]>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const key = snapshotKey(accountId);
  type Projection = Pick<AccountSnapshot, "recent_transactions">;
  const projected = await measure(() =>
    jsonGetFields<Projection>(ctx.client, key, ["recent_transactions"])
  );
  timing.redis_ms = projected.ms;
  const boundedLimit = Math.max(0, Math.min(limit, 200));
  const data = (projected.value?.recent_transactions ?? []).slice(0, boundedLimit).map(withoutSecurity);
  return response(startedAt, data, timing, data.length, 1, [
    `JSON.GET ${key} $.recent_transactions`
  ]);
}

export async function accountPortfolioJoin(ctx: QueryContext, accountId: string): Promise<QueryResult<unknown>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const key = snapshotKey(accountId);
  type Projection = Pick<AccountSnapshot, "account" | "position_count" | "positions">;
  const projected = await measure(() =>
    jsonGetFields<Projection>(ctx.client, key, ["account", "position_count", "positions"])
  );
  timing.redis_ms = projected.ms;
  if (projected.value && projected.value.positions.length !== projected.value.position_count) {
    throw new Error(
      `Account ${accountId} snapshot position_count ${projected.value.position_count} does not match positions length ${projected.value.positions.length}`
    );
  }
  const data = projected.value
    ? { account: projected.value.account, positions: projected.value.positions }
    : null;
  return response(
    startedAt,
    data,
    timing,
    data?.positions.length ?? 0,
    1,
    [`JSON.GET ${key} $.account $.position_count $.positions`]
  );
}

export async function accountActivityJoin(ctx: QueryContext, accountId: string): Promise<QueryResult<unknown>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const key = snapshotKey(accountId);
  type Projection = Pick<AccountSnapshot, "account" | "recent_transactions">;
  const projected = await measure(() =>
    jsonGetFields<Projection>(ctx.client, key, ["account", "recent_transactions"])
  );
  timing.redis_ms = projected.ms;
  const data = projected.value
    ? {
        account: projected.value.account,
        transactions: projected.value.recent_transactions
      }
    : null;
  return response(
    startedAt,
    data,
    timing,
    data?.transactions.length ?? 0,
    1,
    [`JSON.GET ${key} $.account $.recent_transactions`]
  );
}

export async function accountSnapshot(
  ctx: QueryContext,
  accountId: string
): Promise<QueryResult<Omit<AccountSnapshot, "position_index"> | null>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  type Projection = Omit<AccountSnapshot, "position_index">;
  const fields = [
    "_id",
    "account_id",
    "generated_at",
    "revision",
    "account",
    "position_count",
    "transaction_count",
    "total_market_value",
    "recent_transactions",
    "positions"
  ] as const satisfies readonly (keyof Projection)[];
  const { value, ms } = await measure(() => jsonGetFields<Projection>(ctx.client, snapshotKey(accountId), fields));
  timing.redis_ms = ms;
  return response(startedAt, value, timing, value ? 1 : 0, 1, [
    `JSON.GET ${snapshotKey(accountId)} <public-projection-fields>`
  ]);
}

function withoutSecurity<T extends { security?: SecurityProjection }>(
  value: T
): Omit<T, "security"> {
  const { security: _security, ...projection } = value;
  return projection;
}
