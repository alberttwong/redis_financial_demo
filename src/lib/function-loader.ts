import { readFile } from "node:fs/promises";
import type { RedisClientType } from "redis";

const FUNCTION_LIBRARY_URL = new URL("../../redis/functions/financial-transactions.lua", import.meta.url);

export async function loadFinancialTransactionFunctions(client: RedisClientType): Promise<string> {
  const source = await readFile(FUNCTION_LIBRARY_URL, "utf8");
  const result = await client.sendCommand(["FUNCTION", "LOAD", "REPLACE", source]);
  if (typeof result !== "string") {
    throw new Error("FUNCTION LOAD returned an unexpected response");
  }
  return result;
}
