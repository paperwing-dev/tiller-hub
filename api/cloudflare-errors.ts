export interface CloudflareApiMessage {
  code?: number;
  message: string;
}

export class CloudflareApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly method: string;
  readonly errors: CloudflareApiMessage[];

  constructor(options: {
    message: string;
    status: number;
    path: string;
    method: string;
    errors?: CloudflareApiMessage[];
  }) {
    super(options.message);
    this.name = "CloudflareApiError";
    this.status = options.status;
    this.path = options.path;
    this.method = options.method;
    this.errors = options.errors ?? [];
  }
}

export interface CloudflareUiError {
  code: string;
  error: string;
  hint?: string;
  missingPermissions?: string[];
  status: number;
}

function buildTokenHelp(hostname?: string): string {
  const scope = hostname
    ? ` Scope the token to the account and zone that own ${hostname}.`
    : "";
  return "In Cloudflare, create a custom API token and start from the `Edit Cloudflare Workers` template. Then add rows with Scope `Account`, Permission `Access: Apps and Policies`, Access `Edit`; and Scope `Account`, Permission `Access: Service Tokens`, Access `Edit` if your dashboard exposes it." + scope;
}

function workersHint(hostname?: string): string {
  return `In Cloudflare's API token editor, add rows with Scope \`Zone\`, Permission \`Workers Routes\`, Access \`Edit\` and Scope \`Account\`, Permission \`Workers Scripts\`, Access \`Edit\`.${hostname ? ` Scope the token to the account and zone that own ${hostname}.` : ""}`;
}

function accessAppsHint(hostname?: string): string {
  return `In Cloudflare's API token editor, add a row with Scope \`Account\`, Permission \`Access: Apps and Policies\`, Access \`Edit\`.${hostname ? ` Scope the token to the account that owns ${hostname}.` : ""}`;
}

function serviceTokensHint(): string {
  return "In Cloudflare's API token editor, add a row with Scope `Account`, Permission `Access: Service Tokens`, Access `Edit` if your dashboard exposes it. If you do not see that permission, create the token from an account role that can manage Zero Trust service tokens.";
}

function tunnelHint(hostname?: string): string {
  return `In Cloudflare's API token editor, add a row with Scope \`Account\`, Permission \`Cloudflare Tunnel\`, Access \`Edit\`.${hostname ? ` Scope the token to the account that owns ${hostname}.` : ""}`;
}

function dnsHint(hostname?: string): string {
  return `In Cloudflare's API token editor, add a row with Scope \`Zone\`, Permission \`DNS\`, Access \`Edit\`.${hostname ? ` Scope the token to the zone that owns ${hostname}.` : ""}`;
}

function isInvalidHostnameMessage(message: string): boolean {
  return /custom domain is required|enter a valid hostname|enter only the hostname|use your own domain hostname/i.test(message);
}

function isHostnameOutOfScopeMessage(message: string): boolean {
  return /no accessible cloudflare zone matched that hostname/i.test(message);
}

function isAccountLookupMessage(message: string): boolean {
  return /could not determine the cloudflare account for that zone/i.test(message);
}

function isWorkersAliasDisableMessage(message: string): boolean {
  return /did not fully disable the workers\.dev alias/i.test(message);
}

function isWildcardUnsupportedMessage(message: string): boolean {
  return /already (?:covered by the wildcard Cloudflare Access app|protected by the existing Cloudflare Access wildcard app)/i.test(message);
}

function extractWildcardUnsupportedDetails(message: string, fallbackHostname?: string): {
  hostname: string | null;
  wildcardDomain: string | null;
} {
  const match = message.match(
    /requested hostname (?<hostname>\S+) is already protected by the existing Cloudflare Access wildcard app (?<wildcard>\S+)\./i,
  );
  if (match?.groups?.wildcard) {
    return {
      hostname: match.groups.hostname ?? fallbackHostname ?? null,
      wildcardDomain: match.groups.wildcard ?? null,
    };
  }

  const legacyMatch = message.match(/wildcard Cloudflare Access app (?<wildcard>\S+)/i);
  return {
    hostname: fallbackHostname ?? null,
    wildcardDomain: legacyMatch?.groups?.wildcard ?? null,
  };
}

function buildCloudflarePermissionError(
  code: string,
  error: string,
  hint: string,
  missingPermissions: string[],
): CloudflareUiError {
  return {
    code,
    error,
    hint,
    missingPermissions,
    status: 403,
  };
}

export function normalizeCloudflareUiError(error: unknown, hostname?: string): CloudflareUiError {
  const message = error instanceof Error ? error.message : "Cloudflare request failed";

  if (isInvalidHostnameMessage(message)) {
    return {
      code: "invalid_hostname",
      error: message,
      status: 400,
    };
  }

  if (isHostnameOutOfScopeMessage(message)) {
    return {
      code: "hostname_not_in_zone",
      error: hostname
        ? `This token cannot access a Cloudflare zone that owns ${hostname}.`
        : "This token cannot access a Cloudflare zone for that hostname.",
      hint: "In Cloudflare's API token editor, add a row with Scope `Zone`, Permission `Zone`, Access `Read`, and scope the token to the zone that owns this hostname.",
      missingPermissions: ["Zone -> Zone -> Read"],
      status: 403,
    };
  }

  if (isAccountLookupMessage(message)) {
    return {
      code: "account_not_found",
      error: "Cloudflare returned a zone, but not an account id for it.",
      hint: "Make sure the hostname belongs to a zone in an account you can manage, then try again.",
      status: 500,
    };
  }

  if (isWildcardUnsupportedMessage(message)) {
    const details = extractWildcardUnsupportedDetails(message, hostname);
    const resolvedHostname = details.hostname ?? hostname;
    const wildcardDomain = details.wildcardDomain;
    return {
      code: "wildcard_access_unsupported",
      error: resolvedHostname && wildcardDomain
        ? `The requested hostname ${resolvedHostname} is already protected by the existing Cloudflare Access wildcard app ${wildcardDomain}. Tiller only supports exact hosts that it can protect with its own dedicated Access app.`
        : "This hostname is already protected by an existing Cloudflare Access wildcard app. Tiller only supports exact hosts that it can protect with its own dedicated Access app.",
      hint: resolvedHostname && wildcardDomain
        ? `Choose a hostname outside ${wildcardDomain}, or update Cloudflare Access so Tiller can own ${resolvedHostname} directly.`
        : "Choose a hostname outside the wildcard boundary, or update Cloudflare Access so Tiller can own this host directly.",
      status: 409,
    };
  }

  if (/exact-host access is not authoritative yet|still authenticating this hostname against a different application/i.test(message)) {
    return {
      code: "cloudflare_request_failed",
      error: message,
      hint: buildTokenHelp(hostname),
      status: 409,
    };
  }

  if (/policy precedences must be unique/i.test(message)) {
    return {
      code: "access_policy_precedence_conflict",
      error: "Cloudflare rejected the Access policy update because this app already has policies using those precedence slots.",
      hint: "Retry once. If this continues, remove duplicate or stale policies for the exact-host Access app in Cloudflare Zero Trust, then run the protected setup again.",
      status: 409,
    };
  }

  if (isWorkersAliasDisableMessage(message)) {
    return {
      code: "workers_alias_disable_failed",
      error: "Cloudflare attached the custom domain, but did not fully disable the old workers.dev alias and preview URLs.",
      hint: "Retry once. If it keeps failing, disable the Worker subdomain in the Cloudflare dashboard and run Publish & Protect again.",
      status: 409,
    };
  }

  if (error instanceof CloudflareApiError) {
    if (error.status === 401) {
      return {
        code: "invalid_token",
        error: "This Cloudflare API token is invalid, expired, or not accepted by the selected account.",
        hint: buildTokenHelp(hostname),
        status: 401,
      };
    }

    if (error.status === 403) {
      if (error.path.includes("/dns_records")) {
        return buildCloudflarePermissionError(
          "dns_permission_missing",
          hostname
            ? `This token cannot manage DNS records for ${hostname}.`
            : "This token cannot manage DNS records for that hostname.",
          dnsHint(hostname),
          ["Zone -> DNS -> Edit"],
        );
      }

      if (error.path.startsWith("/zones")) {
        return buildCloudflarePermissionError(
          "zone_access_missing",
          hostname
            ? `This token cannot read the Cloudflare zone that owns ${hostname}.`
            : "This token cannot read the Cloudflare zone for that hostname.",
          "In Cloudflare's API token editor, add a row with Scope `Zone`, Permission `Zone`, Access `Read`.",
          ["Zone -> Zone -> Read"],
        );
      }

      if (error.path.includes("/workers/domains") || error.path.includes("/workers/scripts/")) {
        return buildCloudflarePermissionError(
          "workers_permission_missing",
          hostname
            ? `This token cannot manage the Worker domain for ${hostname}.`
            : "This token cannot manage the Worker domain for that hostname.",
          workersHint(hostname),
          ["Zone -> Workers Routes -> Edit", "Account -> Workers Scripts -> Edit"],
        );
      }

      if (error.path.includes("/access/service_tokens")) {
        return buildCloudflarePermissionError(
          "access_service_tokens_permission_missing",
          "This token cannot manage Cloudflare Access service tokens.",
          serviceTokensHint(),
          ["Account -> Access: Service Tokens -> Edit"],
        );
      }

      if (error.path.includes("/access/apps")) {
        return buildCloudflarePermissionError(
          "access_apps_permission_missing",
          hostname
            ? `This token cannot manage Cloudflare Access apps for ${hostname}.`
            : "This token cannot manage Cloudflare Access apps for that hostname.",
          accessAppsHint(hostname),
          ["Account -> Access: Apps and Policies -> Edit"],
        );
      }

      if (error.path.includes("/cfd_tunnel")) {
        return buildCloudflarePermissionError(
          "tunnel_permission_missing",
          hostname
            ? `This token cannot manage Cloudflare Tunnels for ${hostname}.`
            : "This token cannot manage Cloudflare Tunnels for that hostname.",
          tunnelHint(hostname),
          ["Account -> Cloudflare Tunnel -> Edit"],
        );
      }
    }
  }

  return {
    code: "cloudflare_request_failed",
    error: message,
    hint: buildTokenHelp(hostname),
    status: error instanceof CloudflareApiError ? Math.max(400, error.status) : 500,
  };
}
