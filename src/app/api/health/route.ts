import os from "node:os";
import { NextResponse } from "next/server";
import { getRedisConfig } from "../../../lib/config";
import { queryConcurrency } from "../../../lib/query-concurrency";
import { getApiWorkloadClass } from "../../../lib/query-workloads";
import { readRuntimeMetrics } from "../../../lib/runtime-metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      status: "ok",
      worker: {
        hostname: os.hostname(),
        pid: process.pid,
        redis_pool_size: getRedisConfig().poolSize,
        workload_class: getApiWorkloadClass()
      },
      query_concurrency: queryConcurrency.snapshot(),
      runtime: readRuntimeMetrics()
    },
    {
      headers: {
        "cache-control": "no-store"
      }
    }
  );
}
