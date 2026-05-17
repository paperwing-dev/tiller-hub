export function parseEmailList(value: string): string[] {
  const deduped = new Set<string>();
  for (const part of value.split(/[\n,]/)) {
    const email = part.trim().toLowerCase();
    if (!email) continue;
    deduped.add(email);
  }
  return [...deduped];
}
