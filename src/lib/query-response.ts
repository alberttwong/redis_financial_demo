import type { QueryResult } from "./types";

export type SerializedQueryResponse = {
  body: string;
  payloadBytes: number;
  responseBytes: number;
};

export function serializeQueryResponse<T>(result: QueryResult<T>): SerializedQueryResponse {
  const dataJson = JSON.stringify(result.data);
  if (dataJson === undefined) {
    throw new Error("Query response data must be JSON serializable");
  }

  const payloadBytes = Buffer.byteLength(dataJson, "utf8");
  const body = [
    `{"data":${dataJson}`,
    `,"timing":${JSON.stringify(result.timing)}`,
    `,"result_count":${JSON.stringify(result.result_count)}`,
    `,"payload_bytes":${payloadBytes}`,
    `,"redis_command_count":${JSON.stringify(result.redis_command_count)}`,
    `,"commands":${JSON.stringify(result.commands)}}`
  ].join("");

  return {
    body,
    payloadBytes,
    responseBytes: Buffer.byteLength(body, "utf8")
  };
}
