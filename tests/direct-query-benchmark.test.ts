import assert from "node:assert/strict";
import test from "node:test";
import {
  DIRECT_QUERY_PATTERNS,
  directQueryTargetsForPatterns,
  directQueryTargets,
  directQueryWeight,
  parseDirectQueryPatterns
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

test("dedicated direct query targets assign the entire host target to one pattern", () => {
  const patterns = parseDirectQueryPatterns("accountSnapshot");
  const targets = directQueryTargetsForPatterns(2_250, patterns);

  assert.deepEqual(patterns, ["accountSnapshot"]);
  assert.equal(targets.accountSnapshot, 2_250);
  assert.equal(targets.accountPortfolioJoin, 0);
  assert.equal(
    Object.values(targets).reduce((total, target) => total + target, 0),
    2_250
  );
});

test("direct query pattern parsing rejects unknown patterns and removes duplicates", () => {
  assert.deepEqual(
    parseDirectQueryPatterns("accountById, accountById,securityById"),
    ["accountById", "securityById"]
  );
  assert.throws(
    () => parseDirectQueryPatterns("accountById,notAQuery"),
    /Unknown direct query pattern/
  );
});
