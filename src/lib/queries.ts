import { performance } from "node:perf_hooks";
import type { RedisClientType } from "redis";
import { INDEXES } from "./indexes";
import { jsonBytes, measure, roundMs } from "./timing";
import { jsonGet, jsonMGetFields } from "./json";
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
import { tagEquals } from "./tag";
import type {
  AccountRow,
  AccountSnapshot,
  PositionProjection,
  PositionRow,
  QueryResponse,
  SecurityProjection,
  SecurityRow,
  Timings,
  TransactionProjection,
  TransactionRow
} from "./types";

type QueryContext = {
  client: RedisClientType;
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
): QueryResponse<T> {
  return {
    data,
    timing: {
      ...timing,
      total_ms: roundMs(performance.now() - startedAt)
    },
    result_count: resultCount,
    payload_bytes: jsonBytes(data),
    redis_command_count: redisCommandCount,
    commands
  };
}

export async function accountById(ctx: QueryContext, accountId: string): Promise<QueryResponse<AccountRow | null>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const { value, ms } = await measure(() => jsonGet<AccountRow>(ctx.client, accountKey(accountId)));
  timing.redis_ms = ms;
  return response(startedAt, value, timing, value ? 1 : 0, 1, [`JSON.GET ${accountKey(accountId)} $`]);
}

export async function securityById(ctx: QueryContext, securityId: string): Promise<QueryResponse<SecurityRow | null>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const { value, ms } = await measure(() => jsonGet<SecurityRow>(ctx.client, securityKey(securityId)));
  timing.redis_ms = ms;
  return response(startedAt, value, timing, value ? 1 : 0, 1, [`JSON.GET ${securityKey(securityId)} $`]);
}

export async function securityByNo(
  ctx: QueryContext,
  securityNo: string
): Promise<QueryResponse<SecurityProjection[]>> {
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
): Promise<QueryResponse<PositionRow | null>> {
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
): Promise<QueryResponse<PositionProjection[]>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const query = tagEquals("account_id", accountId);
  const search = await measure(() =>
    searchProjected<PositionProjection>(ctx.client, INDEXES.positions, query, POSITION_PROJECTION_FIELDS, {
      limit: 500
    })
  );
  timing.search_ms = search.ms;
  timing.redis_ms = search.ms;
  const data = search.value.rows;
  return response(startedAt, data, timing, data.length, 1, [
    `FT.SEARCH ${INDEXES.positions} "${query}" RETURN <projected-fields> LIMIT 0 500 DIALECT 2`
  ]);
}

export async function transactionById(
  ctx: QueryContext,
  accountId: string,
  securityNo: string,
  acctTypeCode: string,
  transactionId: string
): Promise<QueryResponse<TransactionRow | null>> {
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
): Promise<QueryResponse<TransactionProjection[]>> {
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
): Promise<QueryResponse<TransactionProjection[]>> {
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
      { limit }
    )
  );
  timing.search_ms = search.ms;
  timing.redis_ms = search.ms;
  const data = search.value.rows;
  return response(startedAt, data, timing, data.length, 1, [
    `FT.SEARCH ${INDEXES.transactions} "${query}" RETURN <projected-fields> LIMIT 0 ${limit} DIALECT 2`
  ]);
}

export async function accountPortfolioJoin(ctx: QueryContext, accountId: string): Promise<QueryResponse<unknown>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const base = await measure(() =>
    Promise.all([
      jsonGet<AccountRow>(ctx.client, accountKey(accountId)),
      positionsByAccount({ ...ctx, startedAt }, accountId)
    ])
  );
  const [account, positions] = base.value;
  timing.search_ms = positions.timing.search_ms;
  timing.hydrate_ms = positions.timing.hydrate_ms;

  const join = await measure(async () => {
    const securityIds = [...new Set(positions.data.map((position) => position.security_id))];
    const securities = await jsonMGetFields<SecurityProjection>(
      ctx.client,
      securityIds.map(securityKey),
      SECURITY_PROJECTION_FIELDS
    );
    const byId = new Map(
      securities
        .filter((row): row is SecurityProjection => Boolean(row))
        .map((row) => [row.security_id, row])
    );
    return {
      account,
      positions: positions.data.map((position) => ({
        ...position,
        security: byId.get(position.security_id)
      }))
    };
  });

  timing.join_ms = join.ms;
  timing.redis_ms = roundMs(base.ms + join.ms);
  const securityCount = new Set(positions.data.map((position) => position.security_id)).size;
  return response(
    startedAt,
    join.value,
    timing,
    positions.result_count,
    1 + positions.redis_command_count + securityCount,
    [
      `JSON.GET ${accountKey(accountId)} $`,
      `FT.SEARCH ${INDEXES.positions} "${tagEquals("account_id", accountId)}" RETURN <projected-fields> LIMIT 0 500 DIALECT 2`,
      "JSON.GET sec:<security-id>:info <projected-fields> (pipelined)"
    ]
  );
}

export async function accountActivityJoin(ctx: QueryContext, accountId: string): Promise<QueryResponse<unknown>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const base = await measure(() =>
    Promise.all([
      jsonGet<AccountRow>(ctx.client, accountKey(accountId)),
      transactionsSearch({ ...ctx, startedAt }, { accountId, limit: 100 })
    ])
  );
  const [account, transactions] = base.value;
  timing.search_ms = transactions.timing.search_ms;
  timing.hydrate_ms = transactions.timing.hydrate_ms;

  const join = await measure(async () => {
    const securityIds = [...new Set(transactions.data.map((transaction) => transaction.security_id))];
    const securities = await jsonMGetFields<SecurityProjection>(
      ctx.client,
      securityIds.map(securityKey),
      SECURITY_PROJECTION_FIELDS
    );
    const byId = new Map(
      securities
        .filter((row): row is SecurityProjection => Boolean(row))
        .map((row) => [row.security_id, row])
    );
    return {
      account,
      transactions: transactions.data.map((transaction) => ({
        ...transaction,
        security: byId.get(transaction.security_id)
      }))
    };
  });

  timing.join_ms = join.ms;
  timing.redis_ms = roundMs(base.ms + join.ms);
  const securityCount = new Set(transactions.data.map((transaction) => transaction.security_id)).size;
  return response(
    startedAt,
    join.value,
    timing,
    transactions.result_count,
    1 + transactions.redis_command_count + securityCount,
    [
      `JSON.GET ${accountKey(accountId)} $`,
      `FT.SEARCH ${INDEXES.transactions} "${tagEquals("account_id", accountId)}" RETURN <projected-fields> LIMIT 0 100 DIALECT 2`,
      "JSON.GET sec:<security-id>:info <projected-fields> (pipelined)"
    ]
  );
}

export async function accountSnapshot(ctx: QueryContext, accountId: string): Promise<QueryResponse<AccountSnapshot | null>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const { value, ms } = await measure(() => jsonGet<AccountSnapshot>(ctx.client, snapshotKey(accountId)));
  timing.redis_ms = ms;
  return response(startedAt, value, timing, value ? 1 : 0, 1, [`JSON.GET ${snapshotKey(accountId)} $`]);
}
