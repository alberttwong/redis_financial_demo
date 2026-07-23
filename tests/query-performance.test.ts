import assert from "node:assert/strict";
import test from "node:test";
import type { RedisClientType } from "redis";
import {
  accountActivityJoin,
  accountPortfolioJoin,
  positionsByAccount,
  transactionsByAccount
} from "../src/lib/queries";
import type {
  AccountRow,
  PositionProjection,
  SecurityProjection,
  TransactionProjection
} from "../src/lib/types";

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

const security: SecurityProjection = {
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
  status: "ACTIVE"
};

const positions: Array<PositionProjection & { security: SecurityProjection }> = [
  {
    _id: "A1|SPX1|CASH",
    account_id: "A1",
    security_id: "SEC1",
    security_no: "SPX1",
    acct_type_code: "CASH",
    quantity: 10,
    market_value: 100,
    as_of_date: "2026-07-13",
    projection_version: 1,
    security
  }
];

const transactions: Array<TransactionProjection & { security: SecurityProjection }> = [
  {
    _id: "A1|SEC1|T1",
    transaction_id: "T1",
    account_id: "A1",
    security_id: "SEC1",
    security_no: "SPX1",
    trade_date: "2026-07-13",
    trade_date_epoch: Date.parse("2026-07-13T00:00:00.000Z"),
    acct_type_code: "CASH",
    transaction_type: "BUY",
    quantity: 10,
    amount: 100,
    security
  }
];

function projectedReply(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).map(([field, fieldValue]) => [`$.${field}`, [fieldValue]]))
  );
}

test("accountPortfolioJoin reads the current materialized projection with one command", async () => {
  const commands: string[][] = [];
  const client = {
    async sendCommand(input: string[]) {
      commands.push(input);
      return projectedReply({ account, position_count: positions.length, positions });
    }
  } as unknown as RedisClientType;

  const result = await accountPortfolioJoin({ client }, "A1");

  assert.deepEqual(commands, [[
    "JSON.GET",
    "acct-snapshot:{acct:A1}",
    "$.account",
    "$.position_count",
    "$.positions"
  ]]);
  assert.equal(result.redis_command_count, 1);
  assert.equal(result.result_count, 1);
  assert.deepEqual(result.data, { account, positions });
});

test("accountPortfolioJoin rejects an incomplete materialized projection", async () => {
  const client = {
    async sendCommand() {
      return projectedReply({ account, position_count: positions.length + 1, positions });
    }
  } as unknown as RedisClientType;

  await assert.rejects(
    accountPortfolioJoin({ client }, "A1"),
    /position_count 2 does not match positions length 1/
  );
});

test("accountActivityJoin reads the current materialized projection with one command", async () => {
  const commands: string[][] = [];
  const client = {
    async sendCommand(input: string[]) {
      commands.push(input);
      return projectedReply({ account, recent_transactions: transactions });
    }
  } as unknown as RedisClientType;

  const result = await accountActivityJoin({ client }, "A1");

  assert.deepEqual(commands, [[
    "JSON.GET",
    "acct-snapshot:{acct:A1}",
    "$.account",
    "$.recent_transactions"
  ]]);
  assert.equal(result.redis_command_count, 1);
  assert.equal(result.result_count, 1);
  assert.deepEqual(result.data, { account, transactions });
});

test("positionsByAccount uses the immediately-current snapshot and preserves the compact response shape", async () => {
  const commands: string[][] = [];
  const client = {
    async sendCommand(input: string[]) {
      commands.push(input);
      return projectedReply({ position_count: positions.length, positions });
    }
  } as unknown as RedisClientType;

  const result = await positionsByAccount({ client }, "A1");

  assert.deepEqual(commands, [[
    "JSON.GET",
    "acct-snapshot:{acct:A1}",
    "$.position_count",
    "$.positions"
  ]]);
  assert.equal(result.redis_command_count, 1);
  assert.equal(result.result_count, 1);
  assert.deepEqual(result.data, positions.map(({ security: _security, ...position }) => position));
});

test("transactionsByAccount uses the bounded recent snapshot and preserves the compact response shape", async () => {
  const commands: string[][] = [];
  const client = {
    async sendCommand(input: string[]) {
      commands.push(input);
      return projectedReply({ recent_transactions: transactions });
    }
  } as unknown as RedisClientType;

  const result = await transactionsByAccount({ client }, "A1", 100);

  assert.deepEqual(commands, [[
    "JSON.GET",
    "acct-snapshot:{acct:A1}",
    "$.recent_transactions"
  ]]);
  assert.equal(result.redis_command_count, 1);
  assert.equal(result.result_count, 1);
  assert.deepEqual(result.data, transactions.map(({ security: _security, ...transaction }) => transaction));
});
