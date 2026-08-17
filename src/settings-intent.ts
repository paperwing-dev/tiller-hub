import type { AuthConnectProvider } from "./api";

export interface AuthConnectRequest {
  port: number;
  state: string;
  publicKeyJwk: Record<string, unknown>;
  providers: AuthConnectProvider[];
}

export type AuthConnectIntent =
  | { kind: "request"; request: AuthConnectRequest }
  | { kind: "invalid" }
  | null;

function decodeBase64UrlJson(value: string): unknown {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(
    globalThis.atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4)),
    (character) => character.charCodeAt(0),
  );
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export function parseAuthConnectIntent(search: string): AuthConnectIntent {
  const params = new URLSearchParams(search);
  if (params.get("auth_connect") !== "1") return null;
  const portValue = params.get("port") ?? "";
  const state = params.get("state")?.trim() ?? "";
  const key = params.get("key") ?? "";
  const providerValues = (params.get("providers") ?? "").split(",").filter(Boolean);
  if (
    !/^\d{1,5}$/.test(portValue)
    || !state
    || state.length > 512
    || !key
    || key.length > 4_096
    || providerValues.length < 1
    || providerValues.length > 2
    || new Set(providerValues).size !== providerValues.length
    || providerValues.some((provider) => provider !== "codex" && provider !== "claude")
  ) {
    return { kind: "invalid" };
  }
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return { kind: "invalid" };
  try {
    const publicKeyJwk = decodeBase64UrlJson(key);
    if (!publicKeyJwk || typeof publicKeyJwk !== "object" || Array.isArray(publicKeyJwk)) {
      return { kind: "invalid" };
    }
    return {
      kind: "request",
      request: {
        port,
        state,
        publicKeyJwk: publicKeyJwk as Record<string, unknown>,
        providers: providerValues as AuthConnectProvider[],
      },
    };
  } catch {
    return { kind: "invalid" };
  }
}
