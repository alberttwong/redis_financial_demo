import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { encodeQueryResponse, serializeQueryResponse } from "../src/lib/query-response";
import type { QueryResult } from "../src/lib/types";

test("query responses preserve the public JSON envelope with one data serialization", () => {
  const result: QueryResult<{ account_id: string; description: string }> = {
    data: { account_id: "A1", description: "Résumé 東京" },
    timing: { redis_ms: 1.25, search_ms: 0, hydrate_ms: 0, join_ms: 0, total_ms: 2.5 },
    result_count: 1,
    redis_command_count: 1,
    commands: ["JSON.GET acct:{acct:A1}:info $"]
  };

  const serialized = serializeQueryResponse(result);
  const payloadBytes = Buffer.byteLength(JSON.stringify(result.data), "utf8");
  const expectedBody = JSON.stringify({
    data: result.data,
    timing: result.timing,
    result_count: result.result_count,
    payload_bytes: payloadBytes,
    redis_command_count: result.redis_command_count,
    commands: result.commands
  });

  assert.equal(serialized.body, expectedBody);
  assert.equal(serialized.payloadBytes, payloadBytes);
  assert.equal(serialized.responseBytes, Buffer.byteLength(expectedBody, "utf8"));
  assert.deepEqual(JSON.parse(serialized.body), JSON.parse(expectedBody));
});

test("query response serialization rejects undefined data", () => {
  const result: QueryResult<undefined> = {
    data: undefined,
    timing: { redis_ms: 0, search_ms: 0, hydrate_ms: 0, join_ms: 0, total_ms: 0 },
    result_count: 0,
    redis_command_count: 0,
    commands: []
  };

  assert.throws(() => serializeQueryResponse(result), /must be JSON serializable/);
});

test("query response data is serialized exactly once", () => {
  let calls = 0;
  const result: QueryResult<{ toJSON: () => { value: string } }> = {
    data: {
      toJSON() {
        calls += 1;
        return { value: "large response" };
      }
    },
    timing: { redis_ms: 1, search_ms: 0, hydrate_ms: 0, join_ms: 0, total_ms: 1 },
    result_count: 1,
    redis_command_count: 1,
    commands: ["JSON.GET key $"]
  };

  const serialized = serializeQueryResponse(result);

  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(serialized.body).data, { value: "large response" });
});

test("query responses are gzip encoded when the client accepts gzip", async () => {
  const result: QueryResult<{ value: string }> = {
    data: { value: "compressible-data-".repeat(1_000) },
    timing: { redis_ms: 1, search_ms: 0, hydrate_ms: 0, join_ms: 0, total_ms: 2 },
    result_count: 1,
    redis_command_count: 1,
    commands: ["JSON.GET key $"]
  };
  const serialized = serializeQueryResponse(result);

  const encoded = await encodeQueryResponse(serialized, "br, gzip;q=1");

  assert.equal(encoded.contentEncoding, "gzip");
  assert(encoded.body instanceof ArrayBuffer);
  assert(encoded.wireBytes < encoded.responseBytes);
  assert.equal(gunzipSync(encoded.body).toString("utf8"), serialized.body);
});

test("query responses remain uncompressed for identity or gzip q=0", async () => {
  const result: QueryResult<{ value: string }> = {
    data: { value: "compressible-data-".repeat(1_000) },
    timing: { redis_ms: 1, search_ms: 0, hydrate_ms: 0, join_ms: 0, total_ms: 2 },
    result_count: 1,
    redis_command_count: 1,
    commands: ["JSON.GET key $"]
  };
  const serialized = serializeQueryResponse(result);

  for (const acceptEncoding of ["identity", "gzip;q=0"]) {
    const encoded = await encodeQueryResponse(serialized, acceptEncoding);
    assert.equal(encoded.contentEncoding, undefined);
    assert.equal(encoded.body, serialized.body);
    assert.equal(encoded.wireBytes, serialized.responseBytes);
  }
});
