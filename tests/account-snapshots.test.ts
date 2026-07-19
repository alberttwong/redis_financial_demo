import assert from "node:assert/strict";
import test from "node:test";
import type { RedisClientType } from "redis";
import { rebuildAccountSnapshot } from "../src/lib/account-snapshots";
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

const position: PositionProjection = {
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

const transaction: TransactionProjection = {
  _id: "A1|SEC1|TX1",
  transaction_id: "TX1",
  account_id: "A1",
  security_id: "SEC1",
  security_no: "SPX1",
  trade_date: "2026-07-13",
  trade_date_epoch: Date.parse("2026-07-13T00:00:00.000Z"),
  acct_type_code: "CASH",
  transaction_type: "BUY",
  quantity: 10,
  amount: 1000
};

function projectedSearchReply<T extends object>(key: string, row: T): unknown[] {
  return [
    1,
    key,
    Object.entries(row).flatMap(([field, value]) => [field, JSON.stringify(value)])
  ];
}

function projectedReply(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).map(([field, fieldValue]) => [`$.${field}`, [fieldValue]]))
  );
}

test("rebuildAccountSnapshot seeds a revisioned projection with embedded securities", async () => {
  let snapshotWrite: string[] | undefined;
  const pipeline = {
    addCommand() {
      return pipeline;
    },
    async execAsPipeline() {
      return [projectedReply(security)];
    }
  };
  const client = {
    async sendCommand(input: string[]) {
      if (input[0] === "JSON.GET" && input[1] === "acct:{acct:A1}:info") {
        return JSON.stringify([account]);
      }
      if (input[0] === "FT.SEARCH" && input[1] === "idx:positions") {
        return projectedSearchReply("pos:{acct:A1}:SPX1:CASH", position);
      }
      if (input[0] === "FT.SEARCH" && input[1] === "idx:transactions") {
        return projectedSearchReply("txn:{acct:A1}:SPX1:CASH:TX1", transaction);
      }
      if (input[0] === "JSON.SET") {
        snapshotWrite = input;
        return "OK";
      }
      throw new Error(`Unexpected command: ${input.join(" ")}`);
    },
    multi() {
      return pipeline;
    }
  } as unknown as RedisClientType;

  const result = await rebuildAccountSnapshot(client, "A1");

  assert.equal(result?.revision, 0);
  assert.equal(result?.positions[0]?.security?.security_id, "SEC1");
  assert.equal(result?.recent_transactions[0]?.security?.security_id, "SEC1");
  assert.equal(result?.position_count, 1);
  assert.equal(result?.transaction_count, 1);
  assert.equal(result?.total_market_value, 2500);
  assert.equal(snapshotWrite?.[1], "acct-snapshot:{acct:A1}");
  assert.equal(snapshotWrite?.[3]?.includes("payload"), false);
});
