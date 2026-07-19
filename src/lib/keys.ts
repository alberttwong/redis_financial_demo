export function accountSlotTag(accountId: string): string {
  return `acct:${accountId}`;
}

export function accountKey(accountId: string): string {
  return `acct:{${accountSlotTag(accountId)}}:info`;
}

export function securityKey(securityId: string): string {
  return `sec:${securityId}:info`;
}

export function positionId(accountId: string, securityNo: string, acctTypeCode: string): string {
  return `${accountId}|${securityNo}|${acctTypeCode}`;
}

export function positionKey(accountId: string, securityNo: string, acctTypeCode: string): string {
  return `pos:{${accountSlotTag(accountId)}}:${encodeKeyPart(securityNo)}:${encodeKeyPart(acctTypeCode)}`;
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
  return [
    `txn:{${accountSlotTag(accountId)}}`,
    encodeKeyPart(securityNo),
    encodeKeyPart(acctTypeCode),
    encodeKeyPart(transactionId)
  ].join(":");
}

export function snapshotKey(accountId: string): string {
  return `acct-snapshot:{${accountSlotTag(accountId)}}`;
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}
