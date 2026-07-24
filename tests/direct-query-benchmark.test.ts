import assert from "node:assert/strict";
import test from "node:test";
import {
  DIRECT_QUERY_PATTERNS,
  directQueryTargets,
  directQueryWeight
} from "../src/lib/direct-query-benchmark";

test("direct query targets preserve the full-load 1:5 query ratio", () => {
  const targets = directQueryTargets(180_000);

  assert.equal(DIRECT_QUERY_PATTERNS.length, 12);
  assert.equal(targets.accountById, 9_000);
  assert.equal(targets.accountSnapshot, 9_000);
  assert.equal(targets.accountPortfolioJoin, 45_000);
  assert.equal(targets.accountActivityJoin, 45_000);
  assert.equal(
    Object.values(targets).reduce((total, target) => total + target, 0),
    180_000
  );
});

test("join patterns have five times the direct-load weight", () => {
  assert.equal(directQueryWeight("accountPortfolioJoin"), 5);
  assert.equal(directQueryWeight("accountActivityJoin"), 5);
  assert.equal(directQueryWeight("positionsByAccount"), 1);
});
