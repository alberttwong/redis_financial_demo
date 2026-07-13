import assert from "node:assert/strict";
import test from "node:test";
import type { RedisClientType } from "redis";
import { positionKey, transactionDocumentId, transactionKey } from "../src/lib/keys";
import { applyTransaction } from "../src/lib/transaction-writes";
import type { TransactionRow } from "../src/lib/types";

const transaction: TransactionRow = {
  _id: transactionDocumentId("A1", "SEC1", "TX/1"),
  transaction_id: "TX/1",
  account_id: "A1",
  security_id: "SEC1",
  security_no: "SPX1",
  trade_date: "2026-07-13",
  trade_date_epoch: Date.parse("2026-07-13T00:00:00.000Z"),
  acct_type_code: "CASH",
  transaction_type: "BUY",
  quantity: 10,
  amount: 1000,
  payload: ""
};

test("transaction and position keys resolve to the same position identity", () => {
  assert.equal(positionKey("A1", "SPX1", "CASH"), "pos:A1:SPX1:CASH");
  assert.equal(
    transactionKey("A1", "SPX1", "CASH", "TX/1"),
    "txn:{pos:A1:SPX1:CASH}:TX%2F1"
  );
});

test("applyTransaction calls the atomic Redis Function with both keys", async () => {
  let command: string[] | undefined;
  const client = {
    async sendCommand(input: string[]) {
      command = input;
      return JSON.stringify({ status: "inserted", quantity_delta: 10, position_quantity: 25 });
    }
  } as unknown as RedisClientType;

  const result = await applyTransaction(client, transaction);

  assert.deepEqual(command?.slice(0, 6), [
    "FCALL",
    "apply_transaction",
    "2",
    "txn:{pos:A1:SPX1:CASH}:TX%2F1",
    "pos:A1:SPX1:CASH",
    JSON.stringify(transaction)
  ]);
  assert.equal(result.status, "inserted");
  assert.equal(result.quantity_delta, 10);
  assert.equal(result.position_quantity, 25);
  assert.equal(result.market_value_recalculation_required, true);
});
