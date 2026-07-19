import assert from "node:assert/strict";
import test from "node:test";
import type { RedisClientType } from "redis";
import { positionKey, snapshotKey, transactionDocumentId, transactionKey } from "../src/lib/keys";
import { applyTransaction } from "../src/lib/transaction-writes";
import type { SecurityRow, TransactionRow } from "../src/lib/types";

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

const security: SecurityRow = {
  _id: "SEC1",
  security_id: "SEC1",
  security_no: "SPX1",
  symbol: "TEST",
  cusip: "123456789",
  asset_class: "EQUITY",
  index_name: "S&P 500",
  index_member: true,
  sector: "Technology",
  industry: "Software",
  exchange: "NYSE",
  issuer_name: "Test Issuer",
  status: "ACTIVE",
  payload: "large-security-payload"
};

test("account source and projection keys resolve to the same cluster slot", () => {
  assert.equal(positionKey("A1", "SPX1", "CASH"), "pos:{acct:A1}:SPX1:CASH");
  assert.equal(
    transactionKey("A1", "SPX1", "CASH", "TX/1"),
    "txn:{acct:A1}:SPX1:CASH:TX%2F1"
  );
  assert.equal(snapshotKey("A1"), "acct-snapshot:{acct:A1}");
});

test("applyTransaction calls one atomic Redis Function with source and projection keys", async () => {
  let command: string[] | undefined;
  const client = {
    async sendCommand(input: string[]) {
      command = input;
      return JSON.stringify({
        status: "inserted",
        quantity_delta: 10,
        position_quantity: 25,
        position_projection: {
          _id: "A1|SPX1|CASH",
          account_id: "A1",
          security_id: "SEC1",
          security_no: "SPX1",
          acct_type_code: "CASH",
          quantity: 25,
          market_value: 1000,
          as_of_date: "2026-07-13",
          projection_version: 3
        },
        projection_revision: 8,
        transaction_added: true,
        position_updated: true
      });
    }
  } as unknown as RedisClientType;

  const result = await applyTransaction(client, transaction, security);

  assert.deepEqual(command?.slice(0, 7), [
    "FCALL",
    "apply_transaction",
    "3",
    "txn:{acct:A1}:SPX1:CASH:TX%2F1",
    "pos:{acct:A1}:SPX1:CASH",
    "acct-snapshot:{acct:A1}",
    JSON.stringify(transaction)
  ]);
  assert.equal(command?.[8]?.includes("large-security-payload"), false);
  assert.match(command?.[9] ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.status, "inserted");
  assert.equal(result.quantity_delta, 10);
  assert.equal(result.position_quantity, 25);
  assert.equal(result.position_projection?.projection_version, 3);
  assert.equal(result.projection_revision, 8);
  assert.equal(result.transaction_added, true);
  assert.equal(result.position_updated, true);
  assert.equal(result.market_value_recalculation_required, true);
});
