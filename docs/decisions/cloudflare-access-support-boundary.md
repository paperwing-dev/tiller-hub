# Cloudflare Access Support Boundary

Tiller started with a broader goal: let `Publish & Protect` and `npm run deploy`
work across whatever Cloudflare Access topology a user already had. After
trying that in the real product and against live Cloudflare setups, we stopped
treating every topology as a supported target.

This note records that support boundary. It is not a temporary workaround. It
is a product and implementation decision about how far Tiller should go before
the deployment and protection story becomes too hard to explain, automate, and
support.

## Original goal

The original goal was to make both the UI flow and the deploy script support:

- public `workers.dev`
- protected custom domains
- wildcard-covered domains
- possibly protected `workers.dev`

That sounds clean at the feature-list level, but it pushed several different
Cloudflare Access models into one product surface.

## What broke with protected workers.dev

Protected `workers.dev` looked attractive because it would avoid the custom
domain requirement. In practice it made the product model harder to reason
about.

The main problem was not just browser protection. Browser protection happens at
the Cloudflare edge, while Tiller also has machine and service flows that need
to call back into the hub. When `workers.dev` was allowed to be protected, the
setup flow had to explain and recover a much less obvious combination of:

- browser auth at the edge
- machine access back into the hub
- service-token setup and recovery
- special handling for a hostname that is mostly useful as a bootstrap URL

That was not a clean supported path for the product. The simpler and more
understandable boundary is to treat `workers.dev` as the public bootstrap URL
only, then move to a custom domain when the user wants a stable protected hub.

## What broke with wildcard Access

The original theory for wildcard-covered domains was:

1. detect that a hostname is already covered by a wildcard Access app
2. create a new exact-host Access app for the Tiller hostname
3. let Tiller own the exact host while leaving the wildcard app untouched

That theory did not hold in live validation.

What we observed instead was:

- the existing wildcard app remained the effective auth boundary
- the exact-host app did not become authoritative in the expected way
- bootstrap validation for the exact-host service token did not succeed cleanly

The failure mode was not subtle. Validation returned redirect or gateway-style
failures instead of clean exact-host ownership. In other words, the exact-host
Access app that Tiller created did not reliably become the active protection
boundary for that hostname.

That makes wildcard-covered domains a bad fit for the current design. Tiller
would be pretending to own a boundary that Cloudflare was still resolving
through the broader wildcard app.

## Why we are not adding a second machine-auth system right now

We considered splitting the problem in two:

- keep Cloudflare Access for browser and human access
- add a separate Tiller-managed machine token system for local CLI and hosted
  machine clients

That would likely make wildcard domains and protected `workers.dev` easier to
support. It would also add a second auth system to the product, along with more
state, more recovery cases, and more ways to get the security model wrong.

We rejected that for now because it would mean:

- more moving parts
- more security risk if the machine-token system were scoped poorly
- too much complexity relative to the current product stage

The simpler decision is to keep one Cloudflare Access-based protection model and
support only the domain topologies that fit it cleanly.

## Final decision

The supported boundary is now:

- `workers.dev` is a public bootstrap URL only
- protected deployments require a custom domain
- the custom domain must not already be covered by a wildcard Cloudflare Access
  app that Tiller does not control
- Tiller manages one exact-host Access app for supported protected domains

This is an intentional product boundary. It keeps the deploy and publish flow
understandable, keeps ownership clear, and avoids building support around
Cloudflare behavior that did not hold up in live validation.

## What this means for users

If you already have a wildcard Access app over the target hostname, Tiller's
automatic protection flow is unsupported for that hostname.

In that case, the practical options are:

- use a hostname outside the wildcard Access boundary
- manually rework Cloudflare so Tiller can own the exact host

Browser protection still remains Cloudflare Access. This decision is not a move
away from Access. It is a narrower definition of which Access topologies Tiller
will manage automatically.

## What could change in the future

Wildcard-covered domains could be reconsidered later, but only if one of these
becomes true:

- Tiller adopts a different auth design for machine access
- Cloudflare precedence for exact-host and wildcard Access apps becomes proven
  and reliable enough to build around

Protected `workers.dev` could also be reconsidered later, but it is not part of
the current supported product flow.
