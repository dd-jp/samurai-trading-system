import { truncateForError } from './http/response-errors.js';

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bbot\d{4,}:[A-Za-z0-9_-]+/gi,
  /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+(?:(?!\x5c[\x22\x27])[^\s,;\x22\x27\x7d\]])+/gi,
  /\b(?:APCA-API-KEY-ID|APCA-API-SECRET-KEY|api[_-]?key|api[_-]?secret|secret|token|password|passwd|pwd|auth)\b(?:\x5c?[\x22\x27])?[ \t]*[:=][ \t]*(?:\x5c?[\x22\x27])?(?:(?!\x5c[\x22\x27])[^\s,;&\x22\x27\x7d\]])+/gi,
  /(?<![A-Za-z0-9])(?:client[_-]?secret|access[_-]?token|refresh[_-]?token)(?:\x5c?[\x22\x27])?[ \t]*[:=][ \t]*(?:\x5c?[\x22\x27])?(?:(?!\x5c[\x22\x27])[^\s,;&\x22\x27\x7d\]])+/gi,
  /\b[A-Z][A-Z0-9_]{0,60}_(?:SECRET_KEY|API_KEY|SECRET|TOKEN|PASSWORD|PASSWD)\b(?:\x5c?[\x22\x27])?[ \t]*[:=][ \t]*(?:\x5c?[\x22\x27])?(?:(?!\x5c[\x22\x27])[^\s,;&\x22\x27\x7d\]])+/g,
  /\b[a-z][a-z0-9_]{0,60}_(?:secret_key|api_key|api_secret)\b(?:\x5c?[\x22\x27])?[ \t]*[:=][ \t]*(?:\x5c?[\x22\x27])?(?:(?!\x5c[\x22\x27])[^\s,;&\x22\x27\x7d\]])+/g,
  /(?<=\bAuthorization(?:\x5c?[\x22\x27])?[ \t]*[:=][ \t]*(?:\x5c?[\x22\x27])?)(?:Basic|Token)\s+(?:(?!\x5c[\x22\x27])[^\s,;&\x22\x27\x7d\]])+/gi,
  /(?<=:\/\/[^\s:@/]{0,100}:)[^\s@/\x22\x27,;]{1,200}(?=@)/g,
];

export function maskCredentials(text: string): string {
  let masked = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    masked = masked.replace(pattern, '[REDACTED]');
  }
  return masked;
}

export function sanitizeLogText(text: string): string {
  return truncateForError(maskCredentials(text));
}

export function maskAndCap(text: string, maxChars: number): string {
  const masked = maskCredentials(text);
  return masked.length > maxChars
    ? `${masked.slice(0, maxChars)}… (truncated, ${masked.length} chars total)`
    : masked;
}
