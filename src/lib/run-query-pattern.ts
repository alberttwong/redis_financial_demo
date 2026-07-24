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
} from "./queries";
import type { QueryPattern, QuerySample } from "./benchmark-samples";
import type { RedisConnection } from "./redis";

export async function runQueryPattern(
  pattern: QueryPattern,
  sample: QuerySample,
  startedAt: number,
  client: RedisConnection,
  limit = 100
) {
  const ctx = { client, startedAt };
  switch (pattern) {
    case "accountById":
      return accountById(ctx, sample.account_id);
    case "securityById":
      return securityById(ctx, sample.security_id);
    case "securityByNo":
      return securityByNo(ctx, sample.security_no);
    case "positionByComposite":
      return positionByComposite(
        ctx,
        sample.account_id,
        sample.security_no,
        sample.acct_type_code
      );
    case "positionsByAccount":
      return positionsByAccount(ctx, sample.account_id);
    case "transactionById":
      return transactionById(
        ctx,
        sample.account_id,
        sample.security_no,
        sample.acct_type_code,
        sample.transaction_id
      );
    case "transactionsByComposite":
      return transactionsByComposite(
        ctx,
        sample.account_id,
        sample.security_id,
        sample.trade_date,
        sample.acct_type_code
      );
    case "transactionsByAccount":
      return transactionsByAccount(ctx, sample.account_id, limit);
    case "transactionsBySecurity":
      return transactionsSearch(ctx, { securityId: sample.security_id, limit });
    case "transactionsByAccountSecurity":
      return transactionsSearch(ctx, {
        accountId: sample.account_id,
        securityId: sample.security_id,
        limit
      });
    case "accountPortfolioJoin":
      return accountPortfolioJoin(ctx, sample.account_id);
    case "accountActivityJoin":
      return accountActivityJoin(ctx, sample.account_id);
    case "accountSnapshot":
      return accountSnapshot(ctx, sample.account_id);
  }
}
