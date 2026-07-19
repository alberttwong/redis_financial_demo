import { randomUUID } from "node:crypto";
import { snapshotPositionIndexKey } from "../src/lib/account-snapshots";
import { positionId, positionKey, snapshotKey, transactionDocumentId, transactionKey } from "../src/lib/keys";
import { jsonGet, jsonSet } from "../src/lib/json";
import { closeRedisClient, getRedisClient } from "../src/lib/redis";
import { applyTransaction } from "../src/lib/transaction-writes";
import { loadFinancialTransactionFunctions } from "../src/lib/function-loader";
import type { AccountSnapshot, PositionRow, SecurityProjection, TransactionRow } from "../src/lib/types";

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
  const rejectedId = `REJECTED-${probeId}`;
  const newPositionId = `NEW-POSITION-${probeId}`;
  const newPositionAcctType = "MARGIN";
  const positionRedisKey = positionKey(accountId, securityNo, acctTypeCode);
  const buyRedisKey = transactionKey(accountId, securityNo, acctTypeCode, buyId);
  const sellRedisKey = transactionKey(accountId, securityNo, acctTypeCode, sellId);
  const rejectedRedisKey = transactionKey(accountId, securityNo, acctTypeCode, rejectedId);
  const newPositionRedisKey = positionKey(accountId, securityNo, newPositionAcctType);
  const newPositionTransactionKey = transactionKey(
    accountId,
    securityNo,
    newPositionAcctType,
    newPositionId
  );
  const snapshotRedisKey = snapshotKey(accountId);
  const security: SecurityProjection = {
    _id: securityId,
    security_id: securityId,
    security_no: securityNo,
    symbol: "PROBE",
    cusip: "PROBE",
    asset_class: "EQUITY",
    index_name: "",
    index_member: false,
    sector: "PROBE",
    industry: "PROBE",
    exchange: "PROBE",
    issuer_name: "Probe Security",
    status: "ACTIVE"
  };
  const initialPosition: PositionRow = {
    _id: positionId(accountId, securityNo, acctTypeCode),
    account_id: accountId,
    security_id: securityId,
    security_no: securityNo,
    acct_type_code: acctTypeCode,
    quantity: 0,
    market_value: 0,
    as_of_date: tradeDate,
    projection_version: 0,
    payload: ""
  };
  const { payload: _initialPayload, ...initialPositionProjection } = initialPosition;
  const snapshot: AccountSnapshot = {
    _id: accountId,
    account_id: accountId,
    generated_at: new Date().toISOString(),
    revision: 0,
    account: {
      _id: accountId,
      account_id: accountId,
      household_id: "PROBE",
      advisor_id: "PROBE",
      account_type: "BROKERAGE",
      registration_type: "INDIVIDUAL",
      status: "ACTIVE",
      opened_date: tradeDate
    },
    position_count: 1,
    transaction_count: 0,
    total_market_value: 0,
    recent_transactions: [],
    position_index: { [snapshotPositionIndexKey(initialPosition._id)]: 0 },
    positions: [{ ...initialPositionProjection, security }]
  };

  try {
    await jsonSet(client, positionRedisKey, initialPosition);
    await jsonSet(client, snapshotRedisKey, snapshot);
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
    const insertedBuy = await applyTransaction(client, buy, security);
    assert(insertedBuy.status === "inserted", "first BUY should be inserted");
    assert(insertedBuy.position_quantity === 10, "first BUY should create quantity 10");
    const afterBuy = await jsonGet<AccountSnapshot>(client, snapshotRedisKey);
    assert(afterBuy?.revision === 1, "first BUY should advance the snapshot revision");
    assert(afterBuy.positions[0]?.quantity === 10, "snapshot should immediately contain quantity 10");

    const duplicateBuy = await applyTransaction(client, buy, security);
    assert(duplicateBuy.status === "duplicate", "replayed BUY should be a duplicate");
    assert(duplicateBuy.position_quantity === 10, "duplicate BUY must not change quantity");
    assert(duplicateBuy.projection_revision === 1, "duplicate BUY must not advance the snapshot revision");

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
    const insertedSell = await applyTransaction(client, sell, security);
    assert(insertedSell.status === "inserted", "SELL should be inserted");
    assert(insertedSell.position_quantity === 7, "BUY 10 then SELL 3 should leave quantity 7");
    const afterSell = await jsonGet<AccountSnapshot>(client, snapshotRedisKey);
    assert(afterSell?.revision === 2, "SELL should advance the snapshot revision");
    assert(afterSell.positions[0]?.quantity === 7, "snapshot should immediately contain quantity 7");
    assert(afterSell.recent_transactions[0]?.transaction_id === sellId, "snapshot should expose the SELL immediately");

    const newPosition = makeTransaction({
      transactionId: newPositionId,
      accountId,
      securityId,
      securityNo,
      acctTypeCode: newPositionAcctType,
      tradeDate,
      transactionType: "BUY",
      quantity: 2,
      amount: 200
    });
    const insertedNewPosition = await applyTransaction(client, newPosition, security);
    assert(insertedNewPosition.position_quantity === 2, "new position BUY should create quantity 2");
    const afterNewPosition = await jsonGet<AccountSnapshot>(client, snapshotRedisKey);
    assert(afterNewPosition?.revision === 3, "new position BUY should advance the snapshot revision");
    assert(afterNewPosition.position_count === 2, "snapshot should immediately include the new position");

    await client.del(snapshotRedisKey);
    const rejected = makeTransaction({
      transactionId: rejectedId,
      accountId,
      securityId,
      securityNo,
      acctTypeCode,
      tradeDate,
      transactionType: "BUY",
      quantity: 1,
      amount: 100
    });
    await assertRejects(() => applyTransaction(client, rejected, security), "missing snapshot should reject the write");
    assert((await client.exists(rejectedRedisKey)) === 0, "rejected write must not create a transaction source row");

    console.log(
      "Atomic source and account projection: ok (seeded position, duplicate replay, sell, new position, pre-write rejection)"
    );
  } finally {
    await Promise.all([
      client.del(buyRedisKey),
      client.del(sellRedisKey),
      client.del(rejectedRedisKey),
      client.del(newPositionTransactionKey),
      client.del(positionRedisKey),
      client.del(newPositionRedisKey),
      client.del(snapshotRedisKey)
    ]);
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

async function assertRejects(action: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(message);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedisClient();
  });
