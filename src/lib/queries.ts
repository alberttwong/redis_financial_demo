import { performance } from "node:perf_hooks";
import type { RedisClientType } from "redis";
import { INDEXES } from "./indexes";
import { jsonBytes, measure, roundMs } from "./timing";
import { jsonGet, jsonMGet } from "./json";
import {
  accountKey,
  positionKey,
  securityKey,
  snapshotKey,
  transactionKey
} from "./keys";
import { searchKeys } from "./search";
import { tagEquals } from "./tag";
import type {
  AccountRow,
  AccountSnapshot,
  PositionRow,
  QueryResponse,
  SecurityRow,
  Timings,
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
    commands
  };
}

export async function accountById(ctx: QueryContext, accountId: string): Promise<QueryResponse<AccountRow | null>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const { value, ms } = await measure(() => jsonGet<AccountRow>(ctx.client, accountKey(accountId)));
  timing.redis_ms = ms;
  return response(startedAt, value, timing, value ? 1 : 0, [`JSON.GET ${accountKey(accountId)} $`]);
}

export async function securityById(ctx: QueryContext, securityId: string): Promise<QueryResponse<SecurityRow | null>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const { value, ms } = await measure(() => jsonGet<SecurityRow>(ctx.client, securityKey(securityId)));
  timing.redis_ms = ms;
  return response(startedAt, value, timing, value ? 1 : 0, [`JSON.GET ${securityKey(securityId)} $`]);
}

export async function securityByNo(ctx: QueryContext, securityNo: string): Promise<QueryResponse<SecurityRow[]>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const query = tagEquals("security_no", securityNo);
  const search = await measure(() => searchKeys(ctx.client, INDEXES.securities, query, { limit: 20 }));
  timing.search_ms = search.ms;
  const hydrate = await measure(() => jsonMGet<SecurityRow>(ctx.client, search.value.keys));
  timing.hydrate_ms = hydrate.ms;
  timing.redis_ms = roundMs(search.ms + hydrate.ms);
  const data = hydrate.value.filter((row): row is SecurityRow => Boolean(row));
  return response(startedAt, data, timing, data.length, [
    `FT.SEARCH ${INDEXES.securities} "${query}" NOCONTENT LIMIT 0 20 DIALECT 2`,
    "JSON.GET <matched-security-keys> $ (pipelined)"
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
  return response(startedAt, value, timing, value ? 1 : 0, [`JSON.GET ${key} $`]);
}

export async function positionsByAccount(ctx: QueryContext, accountId: string): Promise<QueryResponse<PositionRow[]>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const query = tagEquals("account_id", accountId);
  const search = await measure(() => searchKeys(ctx.client, INDEXES.positions, query, { limit: 500 }));
  timing.search_ms = search.ms;
  const hydrate = await measure(() => jsonMGet<PositionRow>(ctx.client, search.value.keys));
  timing.hydrate_ms = hydrate.ms;
  timing.redis_ms = roundMs(search.ms + hydrate.ms);
  const data = hydrate.value.filter((row): row is PositionRow => Boolean(row));
  return response(startedAt, data, timing, data.length, [
    `FT.SEARCH ${INDEXES.positions} "${query}" NOCONTENT LIMIT 0 500 DIALECT 2`,
    "JSON.GET <matched-position-keys> $ (pipelined)"
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
  return response(startedAt, value, timing, value ? 1 : 0, [`JSON.GET ${key} $`]);
}

export async function transactionsByComposite(
  ctx: QueryContext,
  accountId: string,
  securityId: string,
  tradeDate: string,
  acctTypeCode: string
): Promise<QueryResponse<TransactionRow[]>> {
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
): Promise<QueryResponse<TransactionRow[]>> {
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
  const search = await measure(() => searchKeys(ctx.client, INDEXES.transactions, query, { limit }));
  timing.search_ms = search.ms;
  const hydrate = await measure(() => jsonMGet<TransactionRow>(ctx.client, search.value.keys));
  timing.hydrate_ms = hydrate.ms;
  timing.redis_ms = roundMs(search.ms + hydrate.ms);
  const data = hydrate.value.filter((row): row is TransactionRow => Boolean(row));
  return response(startedAt, data, timing, data.length, [
    `FT.SEARCH ${INDEXES.transactions} "${query}" NOCONTENT LIMIT 0 ${limit} DIALECT 2`,
    "JSON.GET <matched-transaction-keys> $ (pipelined)"
  ]);
}

export async function accountPortfolioJoin(ctx: QueryContext, accountId: string): Promise<QueryResponse<unknown>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const account = await measure(() => jsonGet<AccountRow>(ctx.client, accountKey(accountId)));
  const positions = await positionsByAccount({ ...ctx, startedAt }, accountId);
  timing.search_ms = positions.timing.search_ms;
  timing.hydrate_ms = roundMs(account.ms + positions.timing.hydrate_ms);

  const join = await measure(async () => {
    const securityNos = [...new Set(positions.data.map((position) => position.security_no))];
    const searches = await Promise.all(
      securityNos.map((securityNo) =>
        searchKeys(ctx.client, INDEXES.securities, tagEquals("security_no", securityNo), { limit: 1 })
      )
    );
    const securityKeys = searches.flatMap((result) => result.keys);
    const securities = await jsonMGet<SecurityRow>(ctx.client, securityKeys);
    const byNo = new Map(
      securities.filter((row): row is SecurityRow => Boolean(row)).map((row) => [row.security_no, stripPayload(row)])
    );
    return {
      account: account.value,
      positions: positions.data.map((position) => ({
        ...position,
        security: byNo.get(position.security_no)
      }))
    };
  });

  timing.join_ms = join.ms;
  timing.redis_ms = roundMs(account.ms + positions.timing.redis_ms + join.ms);
  return response(startedAt, join.value, timing, positions.result_count, [
    `JSON.GET ${accountKey(accountId)} $`,
    `FT.SEARCH ${INDEXES.positions} "${tagEquals("account_id", accountId)}" NOCONTENT LIMIT 0 500 DIALECT 2`,
    `FT.SEARCH ${INDEXES.securities} "@security_no:{...}" NOCONTENT LIMIT 0 1 DIALECT 2`,
    "JSON.GET <matched-position-and-security-keys> $ (pipelined)"
  ]);
}

export async function accountActivityJoin(ctx: QueryContext, accountId: string): Promise<QueryResponse<unknown>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const account = await measure(() => jsonGet<AccountRow>(ctx.client, accountKey(accountId)));
  const transactions = await transactionsSearch({ ...ctx, startedAt }, { accountId, limit: 100 });
  timing.search_ms = transactions.timing.search_ms;
  timing.hydrate_ms = roundMs(account.ms + transactions.timing.hydrate_ms);

  const join = await measure(async () => {
    const securityIds = [...new Set(transactions.data.map((transaction) => transaction.security_id))];
    const securities = await jsonMGet<SecurityRow>(ctx.client, securityIds.map(securityKey));
    const byId = new Map(
      securities.filter((row): row is SecurityRow => Boolean(row)).map((row) => [row.security_id, stripPayload(row)])
    );
    return {
      account: account.value,
      transactions: transactions.data.map((transaction) => ({
        ...transaction,
        security: byId.get(transaction.security_id)
      }))
    };
  });

  timing.join_ms = join.ms;
  timing.redis_ms = roundMs(account.ms + transactions.timing.redis_ms + join.ms);
  return response(startedAt, join.value, timing, transactions.result_count, [
    `JSON.GET ${accountKey(accountId)} $`,
    `FT.SEARCH ${INDEXES.transactions} "${tagEquals("account_id", accountId)}" NOCONTENT LIMIT 0 100 DIALECT 2`,
    "JSON.GET <matched-transaction-and-security-keys> $ (pipelined)"
  ]);
}

export async function accountSnapshot(ctx: QueryContext, accountId: string): Promise<QueryResponse<AccountSnapshot | null>> {
  const startedAt = ctx.startedAt ?? performance.now();
  const timing = emptyTimings();
  const { value, ms } = await measure(() => jsonGet<AccountSnapshot>(ctx.client, snapshotKey(accountId)));
  timing.redis_ms = ms;
  return response(startedAt, value, timing, value ? 1 : 0, [`JSON.GET ${snapshotKey(accountId)} $`]);
}

function stripPayload<T extends { payload?: string }>(row: T): Omit<T, "payload"> {
  const { payload: _payload, ...rest } = row;
  return rest;
}
