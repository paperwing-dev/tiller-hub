# Cloudflare Access Support Boundary

Tiller has one canonical Cloudflare Access trust model for its exact
`workers.dev` hostname. A Hub has one owner email and one installation-wide
service token. Browser requests authenticate as the owner; the CLI, machine
service, runtime harnesses, HTTP clients, and WebSocket clients authenticate as
the service principal.

## Canonical workers.dev boundary

Initial setup starts at the exact deployed `workers.dev` origin and uses the
Paperwing OAuth broker. The broker creates:

1. `Tiller callbacks`, with three configured Bypass destination URIs:
   - `/api/github/webhook`
   - `/api/setup/workers-dev-access/broker/proof`
   - `/api/setup/workers-dev-access/broker/complete`
2. `Tiller Hub`, covering the exact hostname with one owner-email Allow policy,
   one service-token Service Auth policy, and the restricted Cloudflare IdP.
3. One one-year Access service token shared by the owner's CLI, machine
   service, and runtime harnesses.

For owner sign-in, Tiller reuses any local, writable Cloudflare identity
provider already restricted to account members. Federated read-only providers
are excluded because they authenticate through another account. If none exists,
the broker creates `Tiller owner sign-in`, re-reads its type and restriction,
and attaches only that provider to `Tiller Hub`. It does not modify existing
providers or organization defaults.

The owner email comes only from the Cloudflare OAuth user response. The Hub does
not accept an onboarding email, raw-secret request authentication, an inferred
issuer/audience, or the retired JWT setup-claim flow.

At the Worker boundary, both browser and service traffic must present a verified
Cloudflare Access application JWT. The JWT must match the stored issuer and
audience, carry valid time claims, and classify unambiguously as either:

- owner: the signed normalized email is the canonical owner and there is no
  service identity;
- service: there is no owner email and `common_name` is the canonical service
  client ID.

The client ID and secret headers still travel to Cloudflare for service calls;
Tiller does not treat those raw headers as origin authentication.

Cloudflare Access matches a path destination and its descendants. These three
callback paths therefore reserve their descendant namespaces at the edge. The
Worker makes only the exact documented method/path pairs public: descendant
requests still require a signed Access principal and fail closed when they
arrive through the Bypass application. Do not add public routes beneath these
reserved callback paths.

## Fail-closed bootstrap

Before the canonical trust and credential records commit, ordinary APIs and
WebSockets are closed. Only health and setup UI, redacted setup status, OAuth
start, broker proof/completion, and independently authenticated callbacks are
reachable. A missing trust record is never negatively cached.

The broker proves the exact origin with the Hub job secret before a job becomes
connectable. Bootstrap completion atomically stores trust, the current secret,
expiration metadata, and a per-job idempotency tombstone. The browser never
receives the bootstrap result or plaintext service secret.

## Supported existing Access coverage

Provisioning rejects a foreign public Access application that intersects the
target through exact-host, path, wildcard, or multi-destination coverage.
Unknown destination types fail closed.

Account-wide Worker destination types are also hard pre-mutation conflicts in
this release. Cloudflare documents exact public destinations as taking
precedence, but enabling an exception for an existing account-wide application
is deferred to a later release with its own isolated live gate.

## Unsupported Legacy Origins

Worker custom domains, aliases, promotion, rollback, and hostname inference are
unsupported. Top-level ingress returns not found for every noncanonical
production hostname.

The configuration migration may capture a versioned, secret-free list of
legacy custom-domain resource identifiers before clearing old state. It never
deletes an external Cloudflare resource. The owner can download the manifest
and perform cleanup manually after verifying the canonical Hub.

Tiller does not migrate arbitrary legacy Access layouts, transfer ownership,
repair foreign resources, or recover a locked-out installation in this
release.

## Credential delivery and renewal

`tiller connect` creates an ephemeral P-256 key and receives a compact JWE using
ECDH-ES and A256GCM. The owner-authenticated Hub package endpoint encrypts the
exact Hub origin, client ID, current secret, token expiration, state, and
five-minute timestamps. Only the expected CLI can decrypt and consume it.

Annual renewal performs fresh owner OAuth, verifies the same account, Worker,
service-token ID, and client ID, then refreshes and re-reads that token. It
updates only lifecycle timestamps in the Hub. Renewal does not replace the
secret, issue a connection package, or restart machines and processes.

Rotation after suspected compromise, owner transfer, uninstall, and locked-out
recovery remain future work.

The broker never deletes an organization or identity provider. A conditionally
created owner sign-in provider remains reusable if later application or token
provisioning is cleaned up and retried.

## Broker deployment and release gate

The confidential OAuth client and short-lived job storage live in the separate
admin-controlled `packages/auth-broker` deployable. Its required configuration,
safe logging boundary, timing model, and mandatory Free-plan/existing-Zero-
Trust live test matrix are documented in
[`../../auth-broker/README.md`](../../auth-broker/README.md).
