function stableHash(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + index), 0x85ebca6b);
  }
  return `${(left >>> 0).toString(36)}${(right >>> 0).toString(36)}`;
}

export function planWriterTerminalId(
  repoId: string,
  planArtifactId: string,
  generation: number,
): string {
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error("generation must be a positive integer");
  }
  return `plan-writer-${stableHash(`${repoId}\0${planArtifactId}`)}-${generation}`;
}

export function plannerJobSlug(runId: string): string {
  // Preserve the full sanitized run id; truncating its tail could collide.
  const sanitized = runId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `planner-${sanitized}`;
}
