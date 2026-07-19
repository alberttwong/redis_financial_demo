import assert from "node:assert/strict";
import test from "node:test";
import { transactionKey } from "../src/lib/keys";
import { selectTradeAccountsForShard, transactionForPosition } from "../src/lib/trade-load";

test("distributed trade samples preserve each selected position hash tag", () => {
  const position = {
    account_id: "A42",
    security_id: "SEC42",
    security_no: "SPX42",
    acct_type_code: "CASH"
  };
  const transaction = transactionForPosition(
    position,
    "load-1",
    "2026-07-14",
    Date.parse("2026-07-14T00:00:00.000Z"),
    "payload"
  );

  assert.equal(transaction.account_id, position.account_id);
  assert.equal(transaction.security_no, position.security_no);
  assert.match(
    transactionKey(
      transaction.account_id,
      transaction.security_no,
      transaction.acct_type_code,
      transaction.transaction_id
    ),
    /^txn:\{acct:A42\}:SPX42:CASH:/
  );
});

test("trade generator shards select balanced disjoint account partitions", () => {
  const accounts = Array.from({ length: 20 }, (_, index) => `A${String(index + 1).padStart(4, "0")}`);
  const first = selectTradeAccountsForShard(accounts, 11, 1, 2, () => 0.5);
  const second = selectTradeAccountsForShard(accounts, 11, 2, 2, () => 0.5);

  assert.equal(first.length, 6);
  assert.equal(second.length, 5);
  assert.equal(new Set([...first, ...second]).size, 11);
  assert.deepEqual(first.filter((accountId) => second.includes(accountId)), []);
});
