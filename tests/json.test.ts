import assert from "node:assert/strict";
import test from "node:test";
import type { RedisClientType } from "redis";
import { jsonGetFields, jsonMGetFields } from "../src/lib/json";

type Projection = {
  _id: string;
  quantity: number;
};

const fields = ["_id", "quantity"] as const;

test("jsonGetFields requests and parses compact RedisJSON paths", async () => {
  let command: string[] | undefined;
  const client = {
    async sendCommand(input: string[]) {
      command = input;
      return JSON.stringify({ "$._id": ["P1"], "$.quantity": [42] });
    }
  } as unknown as RedisClientType;

  const result = await jsonGetFields<Projection>(client, "pos:A1:SPX1:CASH", fields);

  assert.deepEqual(command, ["JSON.GET", "pos:A1:SPX1:CASH", "$._id", "$.quantity"]);
  assert.deepEqual(result, { _id: "P1", quantity: 42 });
});

test("jsonMGetFields pipelines compact RedisJSON paths", async () => {
  const commands: string[][] = [];
  const replies = [
    JSON.stringify({ "$._id": ["P1"], "$.quantity": [42] }),
    JSON.stringify({ "$._id": ["P2"], "$.quantity": [7] })
  ];
  const pipeline = {
    addCommand(input: string[]) {
      commands.push(input);
      return pipeline;
    },
    async execAsPipeline() {
      return replies;
    }
  };
  const client = {
    multi() {
      return pipeline;
    }
  } as unknown as RedisClientType;

  const result = await jsonMGetFields<Projection>(client, ["pos:1", "pos:2"], fields);

  assert.deepEqual(commands, [
    ["JSON.GET", "pos:1", "$._id", "$.quantity"],
    ["JSON.GET", "pos:2", "$._id", "$.quantity"]
  ]);
  assert.deepEqual(result, [
    { _id: "P1", quantity: 42 },
    { _id: "P2", quantity: 7 }
  ]);
});

test("jsonGetFields parses RedisJSON's single-path array reply", async () => {
  const client = {
    async sendCommand() {
      return JSON.stringify([["T1", "T2"]]);
    }
  } as unknown as RedisClientType;

  const result = await jsonGetFields<{ recent_transactions: string[] }>(
    client,
    "acct-snapshot:{acct:A1}",
    ["recent_transactions"]
  );

  assert.deepEqual(result, { recent_transactions: ["T1", "T2"] });
});
