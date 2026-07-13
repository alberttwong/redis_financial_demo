import { NextResponse } from "next/server";
import { INDEXES } from "@/lib/indexes";
import { jsonGet } from "@/lib/json";
import { getRedisClient } from "@/lib/redis";
import { searchKeys } from "@/lib/search";
import { tagEquals } from "@/lib/tag";
import type { AccountRow, PositionRow, SecurityRow, TransactionRow } from "@/lib/types";

export const dynamic = "force-dynamic";

type QuerySamples = {
  account_id: string;
  security_id: string;
  security_no: string;
  acct_type_code: string;
  trade_date: string;
  transaction_id: string;
};

const FALLBACK_SAMPLES: QuerySamples = {
  account_id: "A00000001",
  security_id: "SEC00000001",
  security_no: "SPX000001",
  acct_type_code: "CASH",
  trade_date: new Date().toISOString().slice(0, 10),
  transaction_id: "sample-transaction-id"
};

export async function GET() {
  try {
    const client = await getRedisClient();
    const transaction = await firstJsonFromIndex<TransactionRow>(INDEXES.transactions, "*");
    const position = transaction ? await positionForTransaction(transaction) : await firstJsonFromIndex<PositionRow>(INDEXES.positions, "*");
    const accountId = transaction?.account_id ?? position?.account_id ?? FALLBACK_SAMPLES.account_id;
    const securityId = transaction?.security_id ?? (await firstJsonFromIndex<SecurityRow>(INDEXES.securities, "*"))?.security_id ?? FALLBACK_SAMPLES.security_id;
    const securityNo = transaction?.security_no ?? position?.security_no ?? (await firstJsonFromIndex<SecurityRow>(INDEXES.securities, "*"))?.security_no ?? FALLBACK_SAMPLES.security_no;
    const acctTypeCode = position?.acct_type_code ?? transaction?.acct_type_code ?? FALLBACK_SAMPLES.acct_type_code;
    const tradeDate = transaction?.trade_date ?? FALLBACK_SAMPLES.trade_date;
    const transactionId = transaction?.transaction_id ?? FALLBACK_SAMPLES.transaction_id;

    const samples: QuerySamples = {
      account_id: accountId,
      security_id: securityId,
      security_no: securityNo,
      acct_type_code: acctTypeCode,
      trade_date: tradeDate,
      transaction_id: transactionId
    };

    return NextResponse.json({ samples });
  } catch (error) {
    return NextResponse.json(
      {
        samples: FALLBACK_SAMPLES,
        error: error instanceof Error ? error.message : "Unable to load query samples"
      },
      { status: 200 }
    );
  }
}

async function firstJsonFromIndex<T>(index: string, query: string): Promise<T | null> {
  const client = await getRedisClient();
  const result = await searchKeys(client, index, query, { limit: 1 });
  const key = result.keys[0];
  if (!key) return null;
  return jsonGet<T>(client, key);
}

async function positionForTransaction(transaction: TransactionRow): Promise<PositionRow | null> {
  const clauses = [
    tagEquals("account_id", transaction.account_id),
    transaction.security_no ? tagEquals("security_no", transaction.security_no) : "",
    tagEquals("acct_type_code", transaction.acct_type_code)
  ].filter(Boolean);
  const position = await firstJsonFromIndex<PositionRow>(
    INDEXES.positions,
    clauses.join(" ")
  );
  return position ?? firstJsonFromIndex<PositionRow>(INDEXES.positions, tagEquals("account_id", transaction.account_id));
}
