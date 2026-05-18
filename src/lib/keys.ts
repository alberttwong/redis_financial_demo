export function accountKey(accountId: string): string {
  return `acct:${accountId}:info`;
}

export function securityKey(securityId: string): string {
  return `sec:${securityId}:info`;
}

export function positionId(accountId: string, securityNo: string, acctTypeCode: string): string {
  return `${accountId}|${securityNo}|${acctTypeCode}`;
}

export function positionKey(accountId: string, securityNo: string, acctTypeCode: string): string {
  return `pos:${accountId}:${securityNo}:${acctTypeCode}`;
}

export function transactionId(
  accountId: string,
  securityId: string,
  tradeDate: string,
  acctTypeCode: string
): string {
  return `${accountId}|${securityId}|${tradeDate}|${acctTypeCode}`;
}

export function transactionKey(
  accountId: string,
  securityId: string,
  tradeDate: string,
  acctTypeCode: string
): string {
  return `txn:${accountId}:${securityId}:${tradeDate}:${acctTypeCode}`;
}

export function snapshotKey(accountId: string): string {
  return `acct:${accountId}:snapshot`;
}
