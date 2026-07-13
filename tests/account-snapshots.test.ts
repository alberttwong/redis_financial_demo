import assert from "node:assert/strict";
import test from "node:test";
import type { RedisClientType } from "redis";
import { refreshAccountSnapshot } from "../src/lib/account-snapshots";
import { transactionDocumentId } from "../src/lib/keys";
import type { AccountRow, PositionRow, SecurityRow, TransactionRow } from "../src/lib/types";

const account: AccountRow = {
  _id: "A1",
  account_id: "A1",
  household_id: "H1",
  advisor_id: "ADV1",
  account_type: "BROKERAGE",
  registration_type: "INDIVIDUAL",
  status: "ACTIVE",
  opened_date: "2020-01-01"
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

const transaction: TransactionRow = {
  _id: transactionDocumentId("A1", "SEC1", "TX1"),
  transaction_id: "TX1",
  account_id: "A1",
  security_id: "SEC1",
  security_no: "SPX1",
  trade_date: "2026-07-13",
  trade_date_epoch: Date.parse("2026-07-13T00:00:00.000Z"),
  acct_type_code: "CASH",
  transaction_type: "BUY",
  quantity: 10,
  amount: 1000,
  payload: "large-transaction-payload"
};

const position: Omit<PositionRow, "payload"> = {
  _id: "A1|SPX1|CASH",
  account_id: "A1",
  security_id: "SEC1",
  security_no: "SPX1",
  acct_type_code: "CASH",
  quantity: 25,
  market_value: 2500,
  as_of_date: "2026-07-13",
  projection_version: 3
};

test("refreshAccountSnapshot calls the account-slot snapshot function with compact projections", async () => {
  let command: string[] | undefined;
  const client = {
    async sendCommand(input: string[]) {
      command = input;
      return JSON.stringify({
        status: "updated",
        transaction_added: true,
        position_updated: true
      });
    }
  } as unknown as RedisClientType;

  const result = await refreshAccountSnapshot(client, { account, security, transaction, position });

  assert.ok(command);
  assert.deepEqual(command.slice(0, 4), ["FCALL", "update_account_snapshot", "1", "acct-snapshot:A1"]);
  assert.equal(command[4].includes("large-transaction-payload"), false);
  assert.equal(command[6].includes("large-security-payload"), false);
  assert.equal(result.status, "updated");
  assert.equal(result.transaction_added, true);
  assert.equal(result.position_updated, true);
});
