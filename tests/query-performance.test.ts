import assert from "node:assert/strict";
import test from "node:test";
import type { RedisClientType } from "redis";
import { accountActivityJoin, accountPortfolioJoin } from "../src/lib/queries";
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

const positions: PositionProjection[] = [
  {
    _id: "A1|SPX1|CASH",
    account_id: "A1",
    security_id: "SEC1",
    security_no: "SPX1",
    acct_type_code: "CASH",
    quantity: 10,
    market_value: 100,
    as_of_date: "2026-07-13",
    projection_version: 1
  },
  {
    _id: "A1|SPX2|CASH",
    account_id: "A1",
    security_id: "SEC2",
    security_no: "SPX2",
    acct_type_code: "CASH",
    quantity: 20,
    market_value: 200,
    as_of_date: "2026-07-13",
    projection_version: 1
  }
];

const securities: SecurityProjection[] = positions.map((position, index) => ({
  _id: position.security_id,
  security_id: position.security_id,
  security_no: position.security_no,
  symbol: `S${index + 1}`,
  cusip: `CUSIP${index + 1}`,
  asset_class: "EQUITY",
  index_name: "S&P 500",
  index_member: true,
  sector: "Technology",
  industry: "Software",
  exchange: "NYSE",
  issuer_name: `Issuer ${index + 1}`,
  status: "ACTIVE"
}));

const transactions: TransactionProjection[] = positions.map((position, index) => ({
  _id: `T${index + 1}`,
  transaction_id: `T${index + 1}`,
  account_id: position.account_id,
  security_id: position.security_id,
  security_no: position.security_no,
  trade_date: "2026-07-13",
  trade_date_epoch: Date.parse("2026-07-13T00:00:00.000Z"),
  acct_type_code: position.acct_type_code,
  transaction_type: "BUY",
  quantity: position.quantity,
  amount: position.market_value
}));

function projectedReply(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).map(([field, fieldValue]) => [`$.${field}`, [fieldValue]]))
  );
}

test("accountPortfolioJoin uses direct projected security gets instead of N+1 searches", async () => {
  const directCommands: string[][] = [];
  const pipelineCommands: string[][] = [];
  const pipelineReplies = [securities.map(projectedReply)];
  let searchStarted = false;
  let accountReadOverlappedSearch = false;

  const client = {
    async sendCommand(input: string[]) {
      directCommands.push(input);
      if (input[0] === "JSON.GET") {
        await new Promise<void>((resolve) => setImmediate(resolve));
        accountReadOverlappedSearch = searchStarted;
        return JSON.stringify([account]);
      }
      if (input[0] === "FT.SEARCH" && input[1] === "idx:positions") {
        searchStarted = true;
        return projectedSearchReply([
          ["pos:A1:SPX1:CASH", positions[0]],
          ["pos:A1:SPX2:CASH", positions[1]]
        ]);
      }
      throw new Error(`Unexpected command: ${input.join(" ")}`);
    },
    multi() {
      const replies = pipelineReplies.shift();
      if (!replies) throw new Error("Unexpected pipeline");
      const pipeline = {
        addCommand(input: string[]) {
          pipelineCommands.push(input);
          return pipeline;
        },
        async execAsPipeline() {
          return replies;
        }
      };
      return pipeline;
    }
  } as unknown as RedisClientType;

  const result = await accountPortfolioJoin({ client }, "A1");

  assert.equal(result.redis_command_count, 4);
  assert.equal(accountReadOverlappedSearch, true);
  assert.equal(directCommands.some((command) => command[1] === "idx:securities"), false);
  const positionSearch = directCommands.find((command) => command[1] === "idx:positions");
  assert.ok(positionSearch?.includes("RETURN"));
  assert.equal(positionSearch?.includes("NOCONTENT"), false);
  assert.equal(pipelineCommands.some((command) => command[1]?.startsWith("pos:")), false);
  assert.deepEqual(
    pipelineCommands.filter((command) => command[1]?.startsWith("sec:")),
    [
      expectSecurityProjectionCommand("sec:SEC1:info"),
      expectSecurityProjectionCommand("sec:SEC2:info")
    ]
  );
  const data = result.data as { positions: Array<PositionProjection & { security?: SecurityProjection }> };
  assert.deepEqual(
    data.positions.map((position) => position.security?.security_id),
    ["SEC1", "SEC2"]
  );
});

test("accountActivityJoin overlaps the account read with one projected transaction search", async () => {
  const directCommands: string[][] = [];
  let searchStarted = false;
  let accountReadOverlappedSearch = false;
  const pipeline = {
    addCommand(input: string[]) {
      assert.match(input[1] ?? "", /^sec:/);
      return pipeline;
    },
    async execAsPipeline() {
      return securities.map(projectedReply);
    }
  };
  const client = {
    async sendCommand(input: string[]) {
      directCommands.push(input);
      if (input[0] === "JSON.GET") {
        await new Promise<void>((resolve) => setImmediate(resolve));
        accountReadOverlappedSearch = searchStarted;
        return JSON.stringify([account]);
      }
      if (input[0] === "FT.SEARCH" && input[1] === "idx:transactions") {
        searchStarted = true;
        return projectedSearchReply([
          ["txn:A1:SPX1:CASH:T1", transactions[0]],
          ["txn:A1:SPX2:CASH:T2", transactions[1]]
        ]);
      }
      throw new Error(`Unexpected command: ${input.join(" ")}`);
    },
    multi() {
      return pipeline;
    }
  } as unknown as RedisClientType;

  const result = await accountActivityJoin({ client }, "A1");

  assert.equal(result.redis_command_count, 4);
  assert.equal(accountReadOverlappedSearch, true);
  const transactionSearch = directCommands.find((command) => command[1] === "idx:transactions");
  assert.ok(transactionSearch?.includes("RETURN"));
  assert.equal(transactionSearch?.includes("NOCONTENT"), false);
});

function projectedSearchReply<T extends object>(rows: Array<[string, T]>): unknown[] {
  return [
    rows.length,
    ...rows.flatMap(([key, row]) => [
      key,
      Object.entries(row).flatMap(([field, value]) => [field, JSON.stringify(value)])
    ])
  ];
}

function expectSecurityProjectionCommand(key: string): string[] {
  return [
    "JSON.GET",
    key,
    "$._id",
    "$.security_id",
    "$.security_no",
    "$.symbol",
    "$.cusip",
    "$.asset_class",
    "$.index_name",
    "$.index_member",
    "$.sector",
    "$.industry",
    "$.exchange",
    "$.issuer_name",
    "$.status"
  ];
}
