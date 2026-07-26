import { describe, expect, it } from "vitest";
import { redactEnvValues, SESSION_ENV_NAMES_VAR } from "../redaction";

describe("redactEnvValues", () => {
  it("redacts short repo session env values but keeps short non-session values", () => {
    expect(redactEnvValues("PIN abc, MODE xy, HTTP 200", {
      [SESSION_ENV_NAMES_VAR]: "PIN,MODE",
      PIN: "abc",
      MODE: "xy",
      STATUS: "200",
    })).toBe("PIN [redacted], MODE [redacted], HTTP 200");
  });

  it("removes provider credentials from Tiller runner errors before logging or diagnostics", () => {
    const credentials = {
      CLAUDE_CODE_OAUTH_TOKEN: "claude-subscription-sentinel",
      ANTHROPIC_API_KEY: "anthropic-api-sentinel",
      OPENAI_API_KEY: "openai-api-sentinel",
    };
    const message = redactEnvValues(
      `runner rejected ${Object.values(credentials).join(" and ")}`,
      credentials,
    );

    expect(message).toContain("[redacted]");
    for (const credential of Object.values(credentials)) {
      expect(message).not.toContain(credential);
    }
  });
});
