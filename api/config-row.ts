export function readOptionalConfigValue(
  sql: Pick<SqlStorage, "exec">,
  key: string,
): string | undefined {
  const rows = sql
    .exec("SELECT value FROM config WHERE key = ?", key)
    .toArray() as { value: string }[];
  return rows[0]?.value;
}
