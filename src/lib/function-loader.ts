import { readFile } from "node:fs/promises";
import { isRedisCluster, redisClusterMasters, sendRedisCommand, type RedisConnection } from "./redis";

const FUNCTION_LIBRARY_URL = new URL("../../redis/functions/financial-transactions.lua", import.meta.url);

export async function loadFinancialTransactionFunctions(client: RedisConnection): Promise<string> {
  const source = await readFile(FUNCTION_LIBRARY_URL, "utf8");
  if (isRedisCluster(client)) {
    const results = await Promise.all(
      redisClusterMasters(client).map(async (master) => {
        const node = await client.nodeClient(master);
        return node.sendCommand(["FUNCTION", "LOAD", "REPLACE", source]);
      })
    );
    if (results.some((result) => typeof result !== "string")) {
      throw new Error("FUNCTION LOAD returned an unexpected cluster response");
    }
    return results[0] as string;
  }

  const result = await sendRedisCommand(client, ["FUNCTION", "LOAD", "REPLACE", source]);
  if (typeof result !== "string") {
    throw new Error("FUNCTION LOAD returned an unexpected response");
  }
  return result;
}
