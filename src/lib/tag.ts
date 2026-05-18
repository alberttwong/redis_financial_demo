const TAG_SPECIALS = /([,.<>{}\[\]"':;!@#$%^&*()\-+=~\s|\\/])/g;

export function escapeTag(value: string): string {
  return value.replace(TAG_SPECIALS, "\\$1");
}

export function tagEquals(field: string, value: string): string {
  return `@${field}:{${escapeTag(value)}}`;
}
