import assert from "node:assert/strict";
import test from "node:test";
import {
  findRedisCloudString,
  redactRedisCloudSecrets
} from "../src/lib/redis-cloud-control-plane";

test("Redis Cloud control-plane data discovers nested endpoints and redacts secrets", () => {
  const subscription = {
    id: 123,
    regions: [
      {
        prometheusEndpoint: "metrics.internal.example",
        secretKey: "subscription-secret"
      }
    ]
  };
  const database = {
    id: 456,
    name: "benchmark-db",
    password: "database-password",
    publicEndpoint: "redis.example:12345",
    nested: {
      authToken: "token-value",
      certificate: "certificate-value"
    }
  };

  assert.equal(
    findRedisCloudString(subscription, "prometheusEndpoint"),
    "metrics.internal.example"
  );
  assert.equal(findRedisCloudString(database, "name"), "benchmark-db");
  const sanitized = JSON.stringify({
    subscription: redactRedisCloudSecrets(subscription),
    database: redactRedisCloudSecrets(database)
  });
  assert.doesNotMatch(
    sanitized,
    /subscription-secret|database-password|token-value|certificate-value/
  );
  assert.match(sanitized, /redis\.example:12345/);
  assert.match(sanitized, /"\[redacted\]"/);
});
