const MAX_INSERT_BYTES = 64 * 1024;

export function sanitizeContributionInsert(text: string): string {
  const sanitized = text
    .replace(/\u001b\[201~/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
  const encoded = new TextEncoder().encode(sanitized);
  if (encoded.byteLength <= MAX_INSERT_BYTES) return sanitized;
  return new TextDecoder().decode(encoded.slice(0, MAX_INSERT_BYTES)).replace(/\uFFFD$/u, "");
}

export function bracketedPasteWithoutEnter(text: string): string {
  return `\u001b[200~${sanitizeContributionInsert(text)}\u001b[201~`;
}

export function bracketedPasteAndSubmit(text: string): string {
  return `${bracketedPasteWithoutEnter(text)}\r`;
}
