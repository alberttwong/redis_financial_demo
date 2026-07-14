import assert from "node:assert/strict";
import test from "node:test";
import { transactionKey } from "../src/lib/keys";
import { transactionForPosition } from "../src/lib/trade-load";

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
    /^txn:\{pos:A42:SPX42:CASH\}:/
  );
});
