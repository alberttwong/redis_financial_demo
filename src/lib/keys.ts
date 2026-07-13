export function accountKey(accountId: string): string {
  return `acct:${accountId}:info`;
}

export function securityKey(securityId: string): string {
  return `sec:${securityId}:info`;
}

export function positionId(accountId: string, securityNo: string, acctTypeCode: string): string {
  return `${accountId}|${securityNo}|${acctTypeCode}`;
}

export function positionSlotTag(accountId: string, securityNo: string, acctTypeCode: string): string {
  return positionKey(accountId, securityNo, acctTypeCode);
}

export function positionKey(accountId: string, securityNo: string, acctTypeCode: string): string {
  return `pos:${accountId}:${securityNo}:${acctTypeCode}`;
}

export function transactionDocumentId(
  accountId: string,
  securityId: string,
  transactionId: string
): string {
  return `${accountId}|${securityId}|${transactionId}`;
}

export function transactionKey(
  accountId: string,
  securityNo: string,
  acctTypeCode: string,
  transactionId: string
): string {
  const slotTag = positionSlotTag(accountId, securityNo, acctTypeCode);
  return `txn:{${slotTag}}:${encodeKeyPart(transactionId)}`;
}

export function snapshotKey(accountId: string): string {
  return `acct-snapshot:${accountId}`;
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}
