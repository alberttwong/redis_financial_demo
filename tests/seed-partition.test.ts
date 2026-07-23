import assert from "node:assert/strict";
import test from "node:test";
import { makePosition, makeTransactionForSequence, seedFaker } from "../src/lib/data";
import {
  resolveSeedPartition,
  transactionsForAccount,
  transactionsInPartition
} from "../src/lib/seed-partition";

test("eight seed partitions cover every account exactly once", () => {
  const partitions = Array.from({ length: 8 }, (_, index) => resolveSeedPartition(6600, index, 8));

  assert.deepEqual(
    partitions.map((partition) => partition.accountCount),
    [825, 825, 825, 825, 825, 825, 825, 825]
  );
  assert.equal(partitions[0].startAccountIndex, 0);
  assert.equal(partitions.at(-1)?.endAccountIndex, 6600);
  for (let index = 1; index < partitions.length; index += 1) {
    assert.equal(partitions[index - 1].endAccountIndex, partitions[index].startAccountIndex);
  }
});

test("transactions are balanced exactly across the 6600-account profile", () => {
  const partitions = Array.from({ length: 8 }, (_, index) => resolveSeedPartition(6600, index, 8));

  assert.equal(transactionsForAccount(240_900_000, 6600, 0), 36_500);
  assert.deepEqual(
    partitions.map((partition) => transactionsInPartition(240_900_000, 6600, partition)),
    Array.from({ length: 8 }, () => 30_112_500)
  );
});

test("seed position and transaction values do not depend on Faker call order", () => {
  const account = { account_id: "A00000123" };
  const security = { security_id: "SEC00000456", security_no: "SPX000456" };
  const positionOptions = { randomSeed: 20_260_518, rowIndex: 61_999, asOfDate: "2026-07-22" };
  const transactionOptions = { randomSeed: 20_260_518, rowIndex: 8_118_123 };

  seedFaker(1);
  const firstPosition = makePosition(account, security, 8192, positionOptions);
  const firstTransaction = makeTransactionForSequence(account, security, 1230, 3960, 8192, transactionOptions);
  seedFaker(999999);
  const secondPosition = makePosition(account, security, 8192, positionOptions);
  const secondTransaction = makeTransactionForSequence(account, security, 1230, 3960, 8192, transactionOptions);

  assert.deepEqual(secondPosition, firstPosition);
  assert.deepEqual(secondTransaction, firstTransaction);
  assert.equal(Buffer.byteLength(JSON.stringify(firstPosition)), 8192);
  assert.equal(Buffer.byteLength(JSON.stringify(firstTransaction)), 8192);
});
