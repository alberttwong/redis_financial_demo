import { faker } from "@faker-js/faker";
import { accountKey, positionId, securityKey, transactionId } from "./keys";
import { withSizedPayload } from "./payload";
import { makeSp500Template } from "./sp500";
import type { AccountRow, PositionRow, SecurityRow, TransactionRow } from "./types";

const accountTypes = ["BROKERAGE", "IRA", "ROTH_IRA", "TRUST", "ADVISORY"];
const registrationTypes = ["INDIVIDUAL", "JOINT", "CUSTODIAL", "TRUST", "CORPORATE"];
const acctTypeCodes = ["CASH", "MARGIN", "RETIREMENT", "ADVISORY"];
const transactionTypes = ["BUY", "SELL", "DIVIDEND", "INTEREST", "TRANSFER", "FEE"];

type AccountRef = Pick<AccountRow, "account_id">;
type PositionSecurityRef = Pick<SecurityRow, "security_no">;
type TransactionSecurityRef = Pick<SecurityRow, "security_id">;

export function seedFaker(seed: number): void {
  faker.seed(seed);
}

export function makeAccount(index: number): AccountRow {
  const accountId = `A${String(index + 1).padStart(8, "0")}`;
  return {
    _id: accountId,
    account_id: accountId,
    household_id: `HH${String(Math.floor(index / 3) + 1).padStart(7, "0")}`,
    advisor_id: `ADV${String(faker.number.int({ min: 1, max: 9999 })).padStart(5, "0")}`,
    account_type: faker.helpers.arrayElement(accountTypes),
    registration_type: faker.helpers.arrayElement(registrationTypes),
    status: faker.helpers.arrayElement(["ACTIVE", "ACTIVE", "ACTIVE", "RESTRICTED", "CLOSED"]),
    opened_date: faker.date.past({ years: 18 }).toISOString().slice(0, 10)
  };
}

export function makeSecurity(index: number, targetBytes: number): SecurityRow {
  const securityId = `SEC${String(index + 1).padStart(8, "0")}`;
  const base = makeSp500Template(index % 500);
  const cycle = Math.floor(index / 500);
  const symbol = cycle === 0 ? base.symbol : `${base.symbol}.${String.fromCharCode(65 + cycle)}`;
  return withSizedPayload(
    {
      _id: securityId,
      security_id: securityId,
      security_no: `SPX${String(index + 1).padStart(6, "0")}`,
      symbol,
      cusip: faker.string.alphanumeric({ length: 9, casing: "upper" }),
      asset_class: "EQUITY",
      index_name: "S&P 500",
      index_member: true,
      sector: base.sector,
      industry: base.industry,
      exchange: base.exchange,
      issuer_name: cycle === 0 ? base.issuer_name : `${base.issuer_name} Class ${String.fromCharCode(65 + cycle)}`,
      status: "ACTIVE"
    },
    targetBytes
  );
}

export function makePosition(account: AccountRef, security: PositionSecurityRef, targetBytes: number): PositionRow {
  const acctTypeCode = faker.helpers.arrayElement(acctTypeCodes);
  const quantity = faker.number.float({ min: 1, max: 4_000, fractionDigits: 4 });
  const marketValue = faker.number.float({ min: 500, max: 750_000, fractionDigits: 2 });
  const id = positionId(account.account_id, security.security_no, acctTypeCode);

  return withSizedPayload(
    {
      _id: id,
      account_id: account.account_id,
      security_no: security.security_no,
      acct_type_code: acctTypeCode,
      quantity,
      market_value: marketValue,
      as_of_date: new Date().toISOString().slice(0, 10)
    },
    targetBytes
  );
}

export function makeTransaction(account: AccountRef, security: TransactionSecurityRef, targetBytes: number): TransactionRow {
  const acctTypeCode = faker.helpers.arrayElement(acctTypeCodes);
  const tradeDate = faker.date.recent({ days: 365 }).toISOString().slice(0, 10);
  const quantity = faker.number.float({ min: 0.01, max: 2_000, fractionDigits: 4 });
  const amount = faker.number.float({ min: 10, max: 250_000, fractionDigits: 2 });
  const id = transactionId(account.account_id, security.security_id, tradeDate, acctTypeCode);

  return withSizedPayload(
    {
      _id: id,
      account_id: account.account_id,
      security_id: security.security_id,
      trade_date: tradeDate,
      trade_date_epoch: Date.parse(`${tradeDate}T00:00:00.000Z`),
      acct_type_code: acctTypeCode,
      transaction_type: faker.helpers.arrayElement(transactionTypes),
      quantity,
      amount
    },
    targetBytes
  );
}

export function makeTransactionForSequence(
  account: AccountRef,
  security: TransactionSecurityRef,
  sequence: number,
  securityCount: number,
  targetBytes: number
): TransactionRow {
  const acctTypeCode = acctTypeCodes[sequence % acctTypeCodes.length];
  const dateOffset = Math.floor(sequence / securityCount);
  const tradeDate = new Date(Date.UTC(2026, 0, 1 - dateOffset)).toISOString().slice(0, 10);
  const quantity = faker.number.float({ min: 0.01, max: 2_000, fractionDigits: 4 });
  const amount = faker.number.float({ min: 10, max: 250_000, fractionDigits: 2 });
  const id = transactionId(account.account_id, security.security_id, tradeDate, acctTypeCode);

  return withSizedPayload(
    {
      _id: id,
      account_id: account.account_id,
      security_id: security.security_id,
      trade_date: tradeDate,
      trade_date_epoch: Date.parse(`${tradeDate}T00:00:00.000Z`),
      acct_type_code: acctTypeCode,
      transaction_type: transactionTypes[sequence % transactionTypes.length],
      quantity,
      amount
    },
    targetBytes
  );
}

export function keyForRow(row: AccountRow | SecurityRow | PositionRow | TransactionRow): string {
  if ("household_id" in row) return accountKey(row.account_id);
  if ("security_id" in row && "security_no" in row) return securityKey(row.security_id);
  if ("market_value" in row) return `pos:${row.account_id}:${row.security_no}:${row.acct_type_code}`;
  return `txn:${row.account_id}:${row.security_id}:${row.trade_date}:${row.acct_type_code}`;
}
