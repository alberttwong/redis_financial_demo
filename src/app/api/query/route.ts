import { NextResponse, type NextRequest } from "next/server";
import {
  accountActivityJoin,
  accountById,
  accountPortfolioJoin,
  accountSnapshot,
  positionByComposite,
  positionsByAccount,
  securityById,
  securityByNo,
  transactionById,
  transactionsByAccount,
  transactionsByComposite,
  transactionsSearch
} from "@/lib/queries";
import { isQueryPattern } from "@/lib/benchmark-samples";
import { queryConcurrency } from "@/lib/query-concurrency";
import { encodeQueryResponse, serializeQueryResponse } from "@/lib/query-response";
import { getApiWorkloadClass, queryWorkloadClass } from "@/lib/query-workloads";
import { getRedisClient } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const startedAt = performance.now();
  const params = request.nextUrl.searchParams;
  const pattern = params.get("pattern") ?? "accountById";

  if (!isQueryPattern(pattern)) {
    return NextResponse.json({ error: `Unknown pattern: ${pattern}`, pattern }, { status: 400 });
  }

  const queryClass = queryWorkloadClass(pattern);
  const apiClass = getApiWorkloadClass();
  const workloadHeaders = {
    "cache-control": "no-store",
    "x-api-workload-class": apiClass,
    "x-query-workload-class": queryClass,
    "x-query-workload-pool": queryClass
  };

  if (apiClass !== "mixed" && apiClass !== queryClass) {
    return NextResponse.json(
      {
        error: `${pattern} is a ${queryClass} query and cannot run on a ${apiClass} API worker`,
        pattern,
        query_workload_class: queryClass,
        api_workload_class: apiClass
      },
      { status: 503, headers: workloadHeaders }
    );
  }

  const admission = queryConcurrency.acquire(pattern);
  const admissionHeaders = {
    ...workloadHeaders,
    "x-query-concurrency-active": String(admission.poolActive),
    "x-query-concurrency-limit": String(admission.poolLimit),
    "x-query-pattern-concurrency-active": String(admission.patternActive),
    "x-query-pattern-concurrency-limit": String(admission.patternReservation),
    "x-query-pattern-concurrency-reservation": String(admission.patternReservation),
    "x-query-pattern-concurrency-borrowed": String(admission.patternBorrowed)
  };
  if (!admission.accepted) {
    return NextResponse.json(
      {
        error: `${queryClass} pool concurrency limit reached`,
        pattern,
        query_workload_class: queryClass,
        rejected_by: admission.rejectedBy,
        pool_active: admission.poolActive,
        pool_limit: admission.poolLimit,
        pattern_active: admission.patternActive,
        pattern_reservation: admission.patternReservation,
        pattern_borrowed: admission.patternBorrowed
      },
      {
        status: 429,
        headers: {
          ...admissionHeaders,
          "retry-after": "1"
        }
      }
    );
  }

  try {
    const client = await getRedisClient();
    const result = await runPattern(pattern, params, startedAt, client);
    const serialized = serializeQueryResponse(result);
    const encoded = await encodeQueryResponse(
      serialized,
      request.headers.get("accept-encoding")
    );
    return new Response(encoded.body, {
      headers: {
        ...admissionHeaders,
        ...(encoded.contentEncoding ? { "content-encoding": encoded.contentEncoding } : {}),
        "content-length": String(encoded.wireBytes),
        "content-type": "application/json; charset=utf-8",
        "vary": "Accept-Encoding",
        "x-query-payload-bytes": String(serialized.payloadBytes),
        "x-query-response-bytes": String(encoded.responseBytes),
        "x-query-wire-bytes": String(encoded.wireBytes),
        "x-redis-command-count": String(result.redis_command_count)
      }
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown query error",
        pattern
      },
      { status: 400, headers: admissionHeaders }
    );
  } finally {
    admission.release();
  }
}

async function runPattern(
  pattern: string,
  params: URLSearchParams,
  startedAt: number,
  client: Awaited<ReturnType<typeof getRedisClient>>
) {
  const accountId = params.get("account_id") ?? "A00000001";
  const securityId = params.get("security_id") ?? "SEC00000001";
  const securityNo = params.get("security_no") ?? "SPX000001";
  const acctTypeCode = params.get("acct_type_code") ?? "CASH";
  const tradeDate = params.get("trade_date") ?? new Date().toISOString().slice(0, 10);
  const transactionId = params.get("transaction_id") ?? "sample-transaction-id";
  const limit = Number.parseInt(params.get("limit") ?? "100", 10);
  const ctx = { client, startedAt };

  switch (pattern) {
    case "accountById":
      return accountById(ctx, accountId);
    case "securityById":
      return securityById(ctx, securityId);
    case "securityByNo":
      return securityByNo(ctx, securityNo);
    case "positionByComposite":
      return positionByComposite(ctx, accountId, securityNo, acctTypeCode);
    case "positionsByAccount":
      return positionsByAccount(ctx, accountId);
    case "transactionById":
      return transactionById(ctx, accountId, securityNo, acctTypeCode, transactionId);
    case "transactionsByComposite":
      return transactionsByComposite(ctx, accountId, securityId, tradeDate, acctTypeCode);
    case "transactionsByAccount":
      return transactionsByAccount(ctx, accountId, limit);
    case "transactionsBySecurity":
      return transactionsSearch(ctx, { securityId, limit });
    case "transactionsByAccountSecurity":
      return transactionsSearch(ctx, { accountId, securityId, limit });
    case "accountPortfolioJoin":
      return accountPortfolioJoin(ctx, accountId);
    case "accountActivityJoin":
      return accountActivityJoin(ctx, accountId);
    case "accountSnapshot":
      return accountSnapshot(ctx, accountId);
    default:
      throw new Error(`Unknown pattern: ${pattern}`);
  }
}
