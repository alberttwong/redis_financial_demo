export type SeedPartition = {
  index: number;
  count: number;
  startAccountIndex: number;
  endAccountIndex: number;
  accountCount: number;
};

export function resolveSeedPartition(accountCount: number, index: number, count: number): SeedPartition {
  if (!Number.isSafeInteger(accountCount) || accountCount < 1) {
    throw new Error("SEED_ACCOUNTS must be a positive integer");
  }
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("SEED_PARTITION_COUNT must be a positive integer");
  }
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
    throw new Error(`SEED_PARTITION_INDEX must be between 0 and ${count - 1}`);
  }

  const startAccountIndex = Math.floor((accountCount * index) / count);
  const endAccountIndex = Math.floor((accountCount * (index + 1)) / count);
  return {
    index,
    count,
    startAccountIndex,
    endAccountIndex,
    accountCount: endAccountIndex - startAccountIndex
  };
}

export function transactionsForAccount(totalTransactions: number, accountCount: number, accountIndex: number): number {
  if (!Number.isSafeInteger(totalTransactions) || totalTransactions < 0) {
    throw new Error("SEED_TRANSACTIONS must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(accountCount) || accountCount < 1) {
    throw new Error("SEED_ACCOUNTS must be a positive integer");
  }
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 0 || accountIndex >= accountCount) {
    throw new Error(`Account index must be between 0 and ${accountCount - 1}`);
  }

  const base = Math.floor(totalTransactions / accountCount);
  return base + (accountIndex < totalTransactions % accountCount ? 1 : 0);
}

export function transactionsInPartition(totalTransactions: number, accountCount: number, partition: SeedPartition): number {
  let total = 0;
  for (let accountIndex = partition.startAccountIndex; accountIndex < partition.endAccountIndex; accountIndex += 1) {
    total += transactionsForAccount(totalTransactions, accountCount, accountIndex);
  }
  return total;
}

export function deterministicIndex(seed: number, rowIndex: number, salt: number, length: number): number {
  if (!Number.isSafeInteger(length) || length < 1) throw new Error("length must be a positive integer");
  return Math.floor(deterministicUnit(seed, rowIndex, salt) * length);
}

export function deterministicFloat(
  seed: number,
  rowIndex: number,
  salt: number,
  min: number,
  max: number,
  fractionDigits: number
): number {
  const scale = 10 ** fractionDigits;
  return Math.round((min + deterministicUnit(seed, rowIndex, salt) * (max - min)) * scale) / scale;
}

function deterministicUnit(seed: number, rowIndex: number, salt: number): number {
  let value = (seed ^ Math.imul((rowIndex + 1) | 0, 0x9e3779b1) ^ salt) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97) >>> 0;
  value = (value ^ (value >>> 15)) >>> 0;
  return value / 0x1_0000_0000;
}
