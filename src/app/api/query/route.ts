import { NextResponse, type NextRequest } from "next/server";
import { isQueryPattern, type QuerySample } from "@/lib/benchmark-samples";
import { queryConcurrency } from "@/lib/query-concurrency";
import {
  encodeQueryResponse,
  queryTimingHeaders,
  serializeQueryResponse
} from "@/lib/query-response";
import { runQueryPattern } from "@/lib/run-query-pattern";
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

  const admission = await queryConcurrency.acquire(pattern, request.signal);
  const admissionHeaders = {
    ...workloadHeaders,
    "x-query-admission-lane": admission.admissionLane,
    "x-query-concurrency-active": String(admission.poolActive),
    "x-query-concurrency-limit": String(admission.poolLimit),
    "x-query-pattern-concurrency-active": String(admission.patternActive),
    "x-query-pattern-concurrency-limit": String(admission.patternReservation),
    "x-query-pattern-concurrency-reservation": String(admission.patternReservation),
    "x-query-pattern-concurrency-borrowed": String(admission.patternBorrowed),
    "x-query-queue-depth": String(admission.queueDepth),
    "x-query-queue-limit": String(admission.queueLimit),
    "x-query-queue-ms": String(admission.queueMs),
    "x-direct-key-concurrency-active": String(admission.directKeyActive),
    "x-direct-key-concurrency-reserved": String(admission.directKeyReserved),
    "x-direct-key-queue-depth": String(admission.directKeyQueued),
    "x-direct-key-queue-limit": String(admission.directKeyQueueLimit)
  };
  if (!admission.accepted) {
    return NextResponse.json(
      {
        error:
          admission.rejectedBy === "queue-timeout"
            ? `${queryClass} query queue wait limit reached`
            : admission.rejectedBy === "request-aborted"
              ? "Request was aborted while waiting for query capacity"
              : `${queryClass} query queue is full`,
        pattern,
        query_workload_class: queryClass,
        rejected_by: admission.rejectedBy,
        pool_active: admission.poolActive,
        pool_limit: admission.poolLimit,
        pattern_active: admission.patternActive,
        pattern_reservation: admission.patternReservation,
        pattern_borrowed: admission.patternBorrowed,
        queue_ms: admission.queueMs,
        queue_depth: admission.queueDepth,
        queue_limit: admission.queueLimit
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
    const result = await runQueryPattern(
      pattern,
      querySample(params),
      startedAt,
      client,
      Number.parseInt(params.get("limit") ?? "100", 10)
    );
    result.timing.queue_ms = admission.queueMs;
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
        "x-redis-command-count": String(result.redis_command_count),
        ...queryTimingHeaders(result.timing)
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

function querySample(params: URLSearchParams): QuerySample {
  return {
    account_id: params.get("account_id") ?? "A00000001",
    security_id: params.get("security_id") ?? "SEC00000001",
    security_no: params.get("security_no") ?? "SPX000001",
    acct_type_code: params.get("acct_type_code") ?? "CASH",
    trade_date: params.get("trade_date") ?? new Date().toISOString().slice(0, 10),
    transaction_id: params.get("transaction_id") ?? "sample-transaction-id"
  };
}
