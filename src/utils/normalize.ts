export function normalizeCode(code: string): string {
  return code.trim().replace(/\s+/g, ' ');
} 