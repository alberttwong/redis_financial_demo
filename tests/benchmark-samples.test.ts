import assert from "node:assert/strict";
import test from "node:test";
import {
  createSeededRandom,
  firstQuerySample,
  selectQuerySample,
  type BenchmarkSamplePool
} from "../src/lib/benchmark-samples";

const pool: BenchmarkSamplePool = {
  accounts: ["A1", "A2"],
  securities: [
    { security_id: "SEC1", security_no: "SPX1" },
    { security_id: "SEC2", security_no: "SPX2" }
  ],
  positions: [
    { account_id: "A1", security_id: "SEC1", security_no: "SPX1", acct_type_code: "CASH" },
    { account_id: "A2", security_id: "SEC2", security_no: "SPX2", acct_type_code: "MARGIN" }
  ],
  transactions: [
    {
      account_id: "A1",
      security_id: "SEC1",
      security_no: "SPX1",
      acct_type_code: "CASH",
      trade_date: "2026-07-13",
      transaction_id: "T1"
    },
    {
      account_id: "A2",
      security_id: "SEC2",
      security_no: "SPX2",
      acct_type_code: "MARGIN",
      trade_date: "2026-07-14",
      transaction_id: "T2"
    }
  ]
};

test("seeded sample selection is reproducible and varies account keys", () => {
  const first = createSeededRandom(42);
  const second = createSeededRandom(42);
  const firstRun = Array.from({ length: 20 }, () => selectQuerySample(pool, "accountPortfolioJoin", first).account_id);
  const secondRun = Array.from({ length: 20 }, () => selectQuerySample(pool, "accountPortfolioJoin", second).account_id);

  assert.deepEqual(firstRun, secondRun);
  assert.deepEqual(new Set(firstRun), new Set(["A1", "A2"]));
});

test("pattern-aware samples preserve composite-key identity", () => {
  const position = selectQuerySample(pool, "positionByComposite", () => 0.99);
  assert.deepEqual(
    {
      account_id: position.account_id,
      security_id: position.security_id,
      security_no: position.security_no,
      acct_type_code: position.acct_type_code
    },
    pool.positions[1]
  );

  const transaction = selectQuerySample(pool, "transactionById", () => 0.99);
  assert.deepEqual(transaction, pool.transactions[1]);
});

test("the workbench-compatible first sample comes from a real transaction", () => {
  assert.deepEqual(firstQuerySample(pool), pool.transactions[0]);
});
