const MIN_REDACTION_VALUE_LENGTH = 4;
export const SESSION_ENV_NAMES_VAR = "TILLER_SESSION_ENV_NAMES";

export function redactValues(
  text: string,
  values: Iterable<string | null | undefined>,
  replacement = "[redacted]",
  minLength = MIN_REDACTION_VALUE_LENGTH,
): string {
  let redacted = text;
  const uniqueValues = [...new Set([...values]
    .filter((value): value is string => typeof value === "string" && value.length >= minLength && value.length > 0))]
    .sort((a, b) => b.length - a.length);

  for (const value of uniqueValues) {
    redacted = redacted.split(value).join(replacement);
  }
  return redacted;
}

function parseEnvNameList(value: string | undefined): Set<string> {
  return new Set((value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean));
}

export function redactEnvValues(text: string, envVars: Record<string, string>): string {
  const sessionEnvNames = parseEnvNameList(envVars[SESSION_ENV_NAMES_VAR]);
  const sessionEnvValues = [...sessionEnvNames].map((name) => envVars[name]);
  const redactedSessionValues = redactValues(text, sessionEnvValues, "[redacted]", 1);
  const otherValues = Object.entries(envVars)
    .filter(([name]) => !sessionEnvNames.has(name))
    .map(([, value]) => value);
  return redactValues(redactedSessionValues, otherValues);
}
