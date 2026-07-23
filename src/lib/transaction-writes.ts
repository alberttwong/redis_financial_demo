import { positionId, positionKey, snapshotKey, transactionDocumentId, transactionKey } from "./keys";
import { SECURITY_PROJECTION_FIELDS } from "./projections";
import { sendRedisCommand, type RedisConnection } from "./redis";
import type { PositionRow, SecurityProjection, SecurityRow, TransactionRow } from "./types";

export const TRANSACTION_TYPES = ["BUY", "SELL", "DIVIDEND", "INTEREST", "TRANSFER", "FEE"] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export type ApplyTransactionResult = {
  status: "inserted" | "duplicate";
  quantity_delta: number;
  position_quantity: number | null;
  position_projection: Omit<PositionRow, "payload"> | null;
  projection_revision: number;
  transaction_added: boolean;
  position_updated: boolean;
  transaction_key: string;
  position_key: string;
  snapshot_key: string;
  market_value_recalculation_required: boolean;
};

type FunctionReply = Pick<
  ApplyTransactionResult,
  | "status"
  | "quantity_delta"
  | "position_quantity"
  | "position_projection"
  | "projection_revision"
  | "transaction_added"
  | "position_updated"
>;

export async function applyTransaction(
  client: RedisConnection,
  transaction: TransactionRow,
  security: SecurityRow | SecurityProjection
): Promise<ApplyTransactionResult> {
  validateTransaction(transaction);
  validateSecurity(security, transaction);

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
  const snapshotRedisKey = snapshotKey(transaction.account_id);
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

  const raw = await sendRedisCommand(client, [
    "FCALL",
    "apply_transaction",
    "3",
    transactionRedisKey,
    positionRedisKey,
    snapshotRedisKey,
    JSON.stringify(transaction),
    JSON.stringify(positionTemplate),
    JSON.stringify(projectSecurity(security)),
    new Date().toISOString()
  ]);
  const reply = parseFunctionReply(raw);

  return {
    ...reply,
    transaction_key: transactionRedisKey,
    position_key: positionRedisKey,
    snapshot_key: snapshotRedisKey,
    market_value_recalculation_required: reply.status === "inserted" && reply.quantity_delta !== 0
  };
}

function projectSecurity(security: SecurityRow | SecurityProjection): SecurityProjection {
  return Object.fromEntries(
    SECURITY_PROJECTION_FIELDS.map((field) => [field, security[field]])
  ) as SecurityProjection;
}

function validateSecurity(security: SecurityRow | SecurityProjection, transaction: TransactionRow): void {
  if (!security || typeof security !== "object") {
    throw new Error("security must be an object");
  }
  for (const field of ["_id", "security_id", "security_no"] as const) {
    if (typeof security[field] !== "string" || security[field].length === 0) {
      throw new Error(`security.${field} must be a non-empty string`);
    }
  }
  if (security.security_id !== transaction.security_id) {
    throw new Error("security.security_id does not match transaction.security_id");
  }
  if (security.security_no !== transaction.security_no) {
    throw new Error("security.security_no does not match transaction.security_no");
  }
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
  if (typeof parsed.projection_revision !== "number" || !Number.isFinite(parsed.projection_revision)) {
    throw new Error("apply_transaction returned an invalid projection_revision");
  }
  if (typeof parsed.transaction_added !== "boolean") {
    throw new Error("apply_transaction returned an invalid transaction_added");
  }
  if (typeof parsed.position_updated !== "boolean") {
    throw new Error("apply_transaction returned an invalid position_updated");
  }
  const positionProjection = parsePositionProjection(parsed.position_projection);

  return {
    status: parsed.status,
    quantity_delta: parsed.quantity_delta,
    position_quantity: parsed.position_quantity ?? null,
    position_projection: positionProjection,
    projection_revision: parsed.projection_revision,
    transaction_added: parsed.transaction_added,
    position_updated: parsed.position_updated
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
