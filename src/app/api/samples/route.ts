import { NextResponse, type NextRequest } from "next/server";
import {
  firstQuerySample,
  loadBenchmarkSamplePool,
  type BenchmarkSamplePool,
  type QuerySample
} from "@/lib/benchmark-samples";
import { getRedisClient } from "@/lib/redis";

export const dynamic = "force-dynamic";

const FALLBACK_SAMPLES: QuerySample = {
  account_id: "A00000001",
  security_id: "SEC00000001",
  security_no: "SPX000001",
  acct_type_code: "CASH",
  trade_date: new Date().toISOString().slice(0, 10),
  transaction_id: "sample-transaction-id"
};

const FALLBACK_POOL: BenchmarkSamplePool = {
  accounts: [FALLBACK_SAMPLES.account_id],
  securities: [
    {
      security_id: FALLBACK_SAMPLES.security_id,
      security_no: FALLBACK_SAMPLES.security_no
    }
  ],
  positions: [
    {
      account_id: FALLBACK_SAMPLES.account_id,
      security_id: FALLBACK_SAMPLES.security_id,
      security_no: FALLBACK_SAMPLES.security_no,
      acct_type_code: FALLBACK_SAMPLES.acct_type_code
    }
  ],
  transactions: [FALLBACK_SAMPLES]
};

export async function GET(request: NextRequest) {
  const count = requestedCount(request.nextUrl.searchParams.get("count"));
  try {
    const client = await getRedisClient();
    const samplePool = await loadBenchmarkSamplePool(client, count);
    return NextResponse.json({
      samples: firstQuerySample(samplePool),
      sample_pool: samplePool,
      sample_pool_size: samplePoolSizes(samplePool)
    });
  } catch (error) {
    return NextResponse.json(
      {
        samples: FALLBACK_SAMPLES,
        sample_pool: FALLBACK_POOL,
        sample_pool_size: samplePoolSizes(FALLBACK_POOL),
        error: error instanceof Error ? error.message : "Unable to load query samples"
      },
      { status: 200 }
    );
  }
}

function requestedCount(value: string | null): number {
  if (!value) return 1;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(5_000, parsed)) : 1;
}

function samplePoolSizes(pool: BenchmarkSamplePool) {
  return Object.fromEntries(Object.entries(pool).map(([name, values]) => [name, values.length]));
}
