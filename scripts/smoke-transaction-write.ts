import { randomUUID } from "node:crypto";
import { positionKey, transactionDocumentId, transactionKey } from "../src/lib/keys";
import { closeRedisClient, getRedisClient } from "../src/lib/redis";
import { applyTransaction } from "../src/lib/transaction-writes";
import { loadFinancialTransactionFunctions } from "../src/lib/function-loader";
import type { TransactionRow } from "../src/lib/types";

async function main() {
  const client = await getRedisClient();
  await loadFinancialTransactionFunctions(client);

  const probeId = randomUUID();
  const accountId = `PROBE-${probeId}`;
  const securityId = `PROBE-SEC-${probeId}`;
  const securityNo = `PROBE-NO-${probeId}`;
  const acctTypeCode = "CASH";
  const tradeDate = new Date().toISOString().slice(0, 10);
  const buyId = `BUY-${probeId}`;
  const sellId = `SELL-${probeId}`;
  const positionRedisKey = positionKey(accountId, securityNo, acctTypeCode);
  const buyRedisKey = transactionKey(accountId, securityNo, acctTypeCode, buyId);
  const sellRedisKey = transactionKey(accountId, securityNo, acctTypeCode, sellId);

  try {
    const buy = makeTransaction({
      transactionId: buyId,
      accountId,
      securityId,
      securityNo,
      acctTypeCode,
      tradeDate,
      transactionType: "BUY",
      quantity: 10,
      amount: 1000
    });
    const insertedBuy = await applyTransaction(client, buy);
    assert(insertedBuy.status === "inserted", "first BUY should be inserted");
    assert(insertedBuy.position_quantity === 10, "first BUY should create quantity 10");

    const duplicateBuy = await applyTransaction(client, buy);
    assert(duplicateBuy.status === "duplicate", "replayed BUY should be a duplicate");
    assert(duplicateBuy.position_quantity === 10, "duplicate BUY must not change quantity");

    const sell = makeTransaction({
      transactionId: sellId,
      accountId,
      securityId,
      securityNo,
      acctTypeCode,
      tradeDate,
      transactionType: "SELL",
      quantity: 3,
      amount: 300
    });
    const insertedSell = await applyTransaction(client, sell);
    assert(insertedSell.status === "inserted", "SELL should be inserted");
    assert(insertedSell.position_quantity === 7, "BUY 10 then SELL 3 should leave quantity 7");

    console.log("Atomic transaction projection: ok (insert, duplicate replay, sell)");
  } finally {
    await Promise.all([client.del(buyRedisKey), client.del(sellRedisKey), client.del(positionRedisKey)]);
  }
}

function makeTransaction(input: {
  transactionId: string;
  accountId: string;
  securityId: string;
  securityNo: string;
  acctTypeCode: string;
  tradeDate: string;
  transactionType: "BUY" | "SELL";
  quantity: number;
  amount: number;
}): TransactionRow {
  return {
    _id: transactionDocumentId(input.accountId, input.securityId, input.transactionId),
    transaction_id: input.transactionId,
    account_id: input.accountId,
    security_id: input.securityId,
    security_no: input.securityNo,
    trade_date: input.tradeDate,
    trade_date_epoch: Date.parse(`${input.tradeDate}T00:00:00.000Z`),
    acct_type_code: input.acctTypeCode,
    transaction_type: input.transactionType,
    quantity: input.quantity,
    amount: input.amount,
    payload: ""
  };
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedisClient();
  });
