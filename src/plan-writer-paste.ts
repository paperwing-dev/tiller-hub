const MAX_INSERT_BYTES = 64 * 1024;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

function sanitizePastePayload(text: string): string {
  return text
    .replace(/\u001b\[201~/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
}

export function sanitizeContributionInsert(text: string): string {
  const sanitized = sanitizePastePayload(text);
  const encoded = new TextEncoder().encode(sanitized);
  if (encoded.byteLength <= MAX_INSERT_BYTES) return sanitized;
  return new TextDecoder().decode(encoded.slice(0, MAX_INSERT_BYTES)).replace(/\uFFFD$/u, "");
}

/** Frames an interactive clipboard paste without applying the contribution-size limit. */
export function bracketedTerminalPaste(text: string): string {
  return `${BRACKETED_PASTE_START}${sanitizePastePayload(text)}${BRACKETED_PASTE_END}`;
}

export function bracketedPasteWithoutEnter(text: string): string {
  return `${BRACKETED_PASTE_START}${sanitizeContributionInsert(text)}${BRACKETED_PASTE_END}`;
}

export function bracketedPasteAndSubmit(text: string): string {
  return `${bracketedPasteWithoutEnter(text)}\r`;
}
