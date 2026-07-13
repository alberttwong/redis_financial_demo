import type { RedisClientType } from "redis";
import { positionId, positionKey, transactionDocumentId, transactionKey } from "./keys";
import type { PositionRow, TransactionRow } from "./types";

export const TRANSACTION_TYPES = ["BUY", "SELL", "DIVIDEND", "INTEREST", "TRANSFER", "FEE"] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export type ApplyTransactionResult = {
  status: "inserted" | "duplicate";
  quantity_delta: number;
  position_quantity: number | null;
  position_projection: Omit<PositionRow, "payload"> | null;
  transaction_key: string;
  position_key: string;
  market_value_recalculation_required: boolean;
};

type FunctionReply = Pick<
  ApplyTransactionResult,
  "status" | "quantity_delta" | "position_quantity" | "position_projection"
>;

export async function applyTransaction(
  client: RedisClientType,
  transaction: TransactionRow
): Promise<ApplyTransactionResult> {
  validateTransaction(transaction);

  const transactionRedisKey = transactionKey(
    transaction.account_id,
    transaction.security_no,
    transaction.acct_type_code,
    transaction.transaction_id
  );
  const positionRedisKey = positionKey(
    transaction.account_id,
    transaction.security_no,
    transaction.acct_type_code
  );
  const positionTemplate: PositionRow = {
    _id: positionId(transaction.account_id, transaction.security_no, transaction.acct_type_code),
    account_id: transaction.account_id,
    security_id: transaction.security_id,
    security_no: transaction.security_no,
    acct_type_code: transaction.acct_type_code,
    quantity: 0,
    market_value: 0,
    as_of_date: transaction.trade_date,
    projection_version: 0,
    payload: ""
  };

  const raw = await client.sendCommand([
    "FCALL",
    "apply_transaction",
    "2",
    transactionRedisKey,
    positionRedisKey,
    JSON.stringify(transaction),
    JSON.stringify(positionTemplate)
  ]);
  const reply = parseFunctionReply(raw);

  return {
    ...reply,
    transaction_key: transactionRedisKey,
    position_key: positionRedisKey,
    market_value_recalculation_required: reply.status === "inserted" && reply.quantity_delta !== 0
  };
}

function validateTransaction(transaction: TransactionRow): void {
  const stringFields: Array<keyof TransactionRow> = [
    "_id",
    "transaction_id",
    "account_id",
    "security_id",
    "security_no",
    "trade_date",
    "acct_type_code"
  ];
  for (const field of stringFields) {
    const value = transaction[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`transaction.${field} must be a non-empty string`);
    }
  }

  for (const field of ["account_id", "security_no", "acct_type_code"] as const) {
    if (/[{}]/.test(transaction[field])) {
      throw new Error(`transaction.${field} cannot contain Redis hash-tag braces`);
    }
  }

  const expectedDocumentId = transactionDocumentId(
    transaction.account_id,
    transaction.security_id,
    transaction.transaction_id
  );
  if (transaction._id !== expectedDocumentId) {
    throw new Error("transaction._id does not match its account, security, and transaction identifiers");
  }

  if (!TRANSACTION_TYPES.includes(transaction.transaction_type as TransactionType)) {
    throw new Error(`Unsupported transaction_type: ${transaction.transaction_type}`);
  }
  if (!Number.isFinite(transaction.quantity) || transaction.quantity <= 0) {
    throw new Error("transaction.quantity must be greater than zero");
  }
  if (!Number.isFinite(transaction.amount)) {
    throw new Error("transaction.amount must be a finite number");
  }
  if (!Number.isFinite(transaction.trade_date_epoch)) {
    throw new Error("transaction.trade_date_epoch must be a finite number");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(transaction.trade_date) ||
    new Date(transaction.trade_date_epoch).toISOString().slice(0, 10) !== transaction.trade_date
  ) {
    throw new Error("transaction.trade_date must match trade_date_epoch in YYYY-MM-DD format");
  }
  if (typeof transaction.payload !== "string") {
    throw new Error("transaction.payload must be a string");
  }
}

function parseFunctionReply(raw: unknown): FunctionReply {
  if (typeof raw !== "string") {
    throw new Error("apply_transaction returned an unexpected response");
  }

  const parsed = JSON.parse(raw) as Partial<FunctionReply>;
  if (parsed.status !== "inserted" && parsed.status !== "duplicate") {
    throw new Error("apply_transaction returned an invalid status");
  }
  if (typeof parsed.quantity_delta !== "number") {
    throw new Error("apply_transaction returned an invalid quantity_delta");
  }
  if (parsed.position_quantity !== null && typeof parsed.position_quantity !== "number") {
    throw new Error("apply_transaction returned an invalid position_quantity");
  }
  const positionProjection = parsePositionProjection(parsed.position_projection);

  return {
    status: parsed.status,
    quantity_delta: parsed.quantity_delta,
    position_quantity: parsed.position_quantity ?? null,
    position_projection: positionProjection
  };
}

function parsePositionProjection(value: unknown): Omit<PositionRow, "payload"> | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("apply_transaction returned an invalid position_projection");
  }

  const position = value as Partial<Omit<PositionRow, "payload">>;
  for (const field of ["_id", "account_id", "security_id", "security_no", "acct_type_code", "as_of_date"] as const) {
    if (typeof position[field] !== "string" || position[field].length === 0) {
      throw new Error(`apply_transaction returned an invalid position_projection.${field}`);
    }
  }
  for (const field of ["quantity", "market_value", "projection_version"] as const) {
    if (typeof position[field] !== "number" || !Number.isFinite(position[field])) {
      throw new Error(`apply_transaction returned an invalid position_projection.${field}`);
    }
  }

  return position as Omit<PositionRow, "payload">;
}
