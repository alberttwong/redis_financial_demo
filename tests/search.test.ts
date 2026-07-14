import assert from "node:assert/strict";
import test from "node:test";
import type { RedisClientType } from "redis";
import { searchProjected } from "../src/lib/search";

type Projection = {
  _id: string;
  account_id: string;
  quantity: number;
  active: boolean;
};

const fields = ["_id", "account_id", "quantity", "active"] as const;

test("searchProjected returns aliased JSON fields in one FT.SEARCH command", async () => {
  let command: string[] | undefined;
  const client = {
    async sendCommand(input: string[]) {
      command = input;
      return [
        2,
        "pos:A1:SPX1:CASH",
        ["_id", '"P1"', "account_id", '"A1"', "quantity", "42", "active", "true"],
        "pos:A1:SPX2:CASH",
        ["_id", '"P2"', "account_id", '"A1"', "quantity", "7", "active", "false"]
      ];
    }
  } as unknown as RedisClientType;

  const result = await searchProjected<Projection>(client, "idx:positions", "@account_id:{A1}", fields, {
    limit: 500
  });

  assert.deepEqual(command, [
    "FT.SEARCH",
    "idx:positions",
    "@account_id:{A1}",
    "RETURN",
    "12",
    "$._id",
    "AS",
    "_id",
    "$.account_id",
    "AS",
    "account_id",
    "$.quantity",
    "AS",
    "quantity",
    "$.active",
    "AS",
    "active",
    "LIMIT",
    "0",
    "500",
    "DIALECT",
    "2"
  ]);
  assert.deepEqual(result, {
    total: 2,
    rows: [
      { _id: "P1", account_id: "A1", quantity: 42, active: true },
      { _id: "P2", account_id: "A1", quantity: 7, active: false }
    ]
  });
});

test("searchProjected skips expired results with no returned attributes", async () => {
  const client = {
    async sendCommand() {
      return [1, "pos:expired", null];
    }
  } as unknown as RedisClientType;

  const result = await searchProjected<Projection>(client, "idx:positions", "*", fields);

  assert.deepEqual(result, { total: 1, rows: [] });
});
