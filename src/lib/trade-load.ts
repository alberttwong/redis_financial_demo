import type { PositionSample } from "./benchmark-samples";
import { transactionDocumentId } from "./keys";
import type { TransactionRow } from "./types";

export function transactionForPosition(
  position: PositionSample,
  transactionId: string,
  tradeDate: string,
  tradeDateEpoch: number,
  payload: string
): TransactionRow {
  return {
    _id: transactionDocumentId(position.account_id, position.security_id, transactionId),
    transaction_id: transactionId,
    account_id: position.account_id,
    security_id: position.security_id,
    security_no: position.security_no,
    trade_date: tradeDate,
    trade_date_epoch: tradeDateEpoch,
    acct_type_code: position.acct_type_code,
    transaction_type: "BUY",
    quantity: 1,
    amount: 100,
    payload
  };
}

export function selectTradeAccountsForShard(
  accountIds: string[],
  totalSampleSize: number,
  shardIndex: number,
  shardCount: number,
  random: () => number
): string[] {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error("Trade shard count must be a positive integer");
  }
  if (!Number.isInteger(shardIndex) || shardIndex < 1 || shardIndex > shardCount) {
    throw new Error(`Trade shard index must be between 1 and ${shardCount}`);
  }

  const uniqueAccountIds = [...new Set(accountIds)].sort();
  const shardAccountIds = uniqueAccountIds.filter(
    (_accountId, index) => index % shardCount === shardIndex - 1
  );
  for (let index = shardAccountIds.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shardAccountIds[index], shardAccountIds[swapIndex]] = [
      shardAccountIds[swapIndex],
      shardAccountIds[index]
    ];
  }

  const base = Math.floor(totalSampleSize / shardCount);
  const remainder = totalSampleSize % shardCount;
  const shardSampleSize = base + (shardIndex <= remainder ? 1 : 0);
  if (shardAccountIds.length < shardSampleSize) {
    throw new Error(
      `Trade shard ${shardIndex}/${shardCount} has ${shardAccountIds.length} accounts but needs ${shardSampleSize}`
    );
  }
  return shardAccountIds.slice(0, shardSampleSize);
}
