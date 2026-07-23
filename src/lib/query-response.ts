import { promisify } from "node:util";
import { constants, gzip } from "node:zlib";
import type { QueryResult } from "./types";

const gzipAsync = promisify(gzip);

export type SerializedQueryResponse = {
  body: string;
  payloadBytes: number;
  responseBytes: number;
};

export type EncodedQueryResponse = {
  body: string | ArrayBuffer;
  contentEncoding?: "gzip";
  responseBytes: number;
  wireBytes: number;
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

export async function encodeQueryResponse(
  response: SerializedQueryResponse,
  acceptEncoding: string | null,
  minimumBytes = 1_024
): Promise<EncodedQueryResponse> {
  if (response.responseBytes < minimumBytes || !acceptsGzip(acceptEncoding)) {
    return {
      body: response.body,
      responseBytes: response.responseBytes,
      wireBytes: response.responseBytes
    };
  }

  const compressed = await gzipAsync(Buffer.from(response.body, "utf8"), {
    level: constants.Z_BEST_SPEED
  });
  return {
    body: Uint8Array.from(compressed).buffer as ArrayBuffer,
    contentEncoding: "gzip",
    responseBytes: response.responseBytes,
    wireBytes: compressed.byteLength
  };
}

function acceptsGzip(value: string | null): boolean {
  if (!value) return false;
  return value.split(",").some((entry) => {
    const [encoding, ...parameters] = entry.trim().toLowerCase().split(";");
    if (encoding !== "gzip" && encoding !== "*") return false;
    const quality = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith("q="));
    return quality === undefined || Number(quality.slice(2)) > 0;
  });
}
