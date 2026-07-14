import type { PositionSample } from "./benchmark-samples";
import { transactionDocumentId } from "./keys";
import type { TransactionRow } from "./types";

export function transactionForPosition(
  position: PositionSample,
  transactionId: string,
  tradeDate: string,
  tradeDateEpoch: number,
  payload: string
): TransactionRow {
  return {
    _id: transactionDocumentId(position.account_id, position.security_id, transactionId),
    transaction_id: transactionId,
    account_id: position.account_id,
    security_id: position.security_id,
    security_no: position.security_no,
    trade_date: tradeDate,
    trade_date_epoch: tradeDateEpoch,
    acct_type_code: position.acct_type_code,
    transaction_type: "BUY",
    quantity: 1,
    amount: 100,
    payload
  };
}
