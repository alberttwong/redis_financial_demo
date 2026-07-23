import assert from "node:assert/strict";
import test from "node:test";
import calculateSlot from "cluster-key-slot";
import type { RedisClusterType } from "redis";
import { executeRedisPipeline } from "../src/lib/redis";

test("cluster pipeline groups commands by primary and preserves reply order", async () => {
  const firstMaster = { id: "first", address: "first:6379" };
  const secondMaster = { id: "second", address: "second:6379" };
  const commands = [
    ["JSON.SET", "pos:{acct:A1}:one", "$", "{}"],
    ["JSON.SET", "pos:{acct:A2}:two", "$", "{}"],
    ["JSON.GET", "pos:{acct:A3}:three", "$"]
  ];
  const executed = new Map<string, string[][]>();
  const slots = Array.from({ length: 16_384 }, (_, slot) => ({
    master: slot % 2 === 0 ? firstMaster : secondMaster
  }));
  const cluster = {
    masters: [firstMaster, secondMaster],
    slots,
    async nodeClient(master: { id: string }) {
      const nodeCommands: string[][] = [];
      executed.set(master.id, nodeCommands);
      const pipeline = {
        addCommand(command: string[]) {
          nodeCommands.push(command);
          return pipeline;
        },
        async execAsPipeline() {
          return nodeCommands.map((command) => `${master.id}:${command[1]}`);
        }
      };
      return { multi: () => pipeline };
    }
  } as unknown as RedisClusterType;

  const replies = await executeRedisPipeline(cluster, commands);

  assert.deepEqual(
    replies,
    commands.map((command) => {
      const master = slots[calculateSlot(command[1])].master;
      return `${master.id}:${command[1]}`;
    })
  );
  for (const [masterId, nodeCommands] of executed) {
    assert.ok(
      nodeCommands.every((command) => slots[calculateSlot(command[1])].master.id === masterId),
      `all commands for ${masterId} should hash to that primary`
    );
  }
});
