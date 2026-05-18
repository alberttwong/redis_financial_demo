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
  transactionByComposite,
  transactionsSearch
} from "@/lib/queries";
import { getRedisClient } from "@/lib/redis";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const startedAt = performance.now();
  const params = request.nextUrl.searchParams;
  const pattern = params.get("pattern") ?? "accountById";

  try {
    const client = await getRedisClient();
    const result = await runPattern(pattern, params, startedAt, client);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown query error",
        pattern
      },
      { status: 400 }
    );
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
  const securityNo = params.get("security_no") ?? "SNO00000001";
  const acctTypeCode = params.get("acct_type_code") ?? "CASH";
  const tradeDate = params.get("trade_date") ?? new Date().toISOString().slice(0, 10);
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
    case "transactionByComposite":
      return transactionByComposite(ctx, accountId, securityId, tradeDate, acctTypeCode);
    case "transactionsByAccount":
      return transactionsSearch(ctx, { accountId, limit });
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
