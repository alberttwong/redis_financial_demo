export function accountSlotTag(accountId: string): string {
  return `acct:${accountId}`;
}

export function accountKey(accountId: string): string {
  return `acct:{${accountSlotTag(accountId)}}:info`;
}

export function securityKey(securityId: string): string {
  return `sec:${securityId}:info`;
}

export function securityByNoViewKey(securityNo: string): string {
  return `query-view:security-by-no:{security-no:${encodeKeyPart(securityNo)}}`;
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

export function transactionsBySecurityViewKey(securityId: string): string {
  return `query-view:transactions-by-security:{security:${encodeKeyPart(securityId)}}`;
}

export function transactionsByAccountSecurityViewKey(
  accountId: string,
  securityId: string
): string {
  return `query-view:transactions-by-account-security:{${accountSlotTag(accountId)}}:${encodeKeyPart(securityId)}`;
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}
