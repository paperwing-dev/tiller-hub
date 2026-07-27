# Tiller

Tiller is our vibe coding platform built with Cloudflare primitives. It recreates the portions of Claude Code and Codex that we find useful, and adds more control and observability. There are a million of these apps, but this one is personalized to us, and it's grown to be quite involved.

## Current Status

This package is currently in Alpha. If you found it, thanks for checking out [paperwing](https://paperwing.dev). We are using it to dogfood Tiller, but underlying features are still changing, designs are updating, and performance is being improved. Use at your own risk and assume settings might not carry over to new versions.

It's working pretty well though. Give it a whirl.

## Features

### Interesting Features

- Choose Cloudflare Containers or Your machine as the execution backend for new workloads.
- CLI for local control over the Hub and execution-machine setup.
- Control subagents individually, instead of the model controlling them in the background.
- Schedule selected plans for unattended implementation.
- Remote control the always running tiller server by adding tiller as a PWA.
- Opinionated UI with dedicated planning and review modes.

### Planned Features

- Voice mode supported for planning, implementing, and review sections.
- More models and better support for OpenCode.
- Deploy previews of environments
- Showing costs of interactions, and cost breakdowns for each section
- More support for chaining subagent follow ups.

## Getting Started

1. Have a Cloudflare and Github Account (read the requirements below for more information).
2. Deploy the hub using the "Cloudflare Deploy" button.
3. On Cloudflare's deployment configuration page, enter the required
   `TILLER_REGION` closest to you. Cloudflare does not detect this
   automatically:
   - `wnam` (Western North America)
   - `enam` (Eastern North America)
   - `weur` (Western Europe)
   - `eeur` (Eastern Europe)
   - `apac` (Asia Pacific)
   - `oc` (Oceania)
     Cloudflare leaves this field blank and requires a value. The deployment
     script also stops before creating the R2 bucket or Worker if the choice is
     missing or invalid.
4. Once deployed, open the Tiller UI and finish the setup wizard.
   - This protects the exact workers.dev Hub with Cloudflare Access and sets up your GitHub App.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/paperwing-dev/tiller-hub)

### Tiller CLI

While you can develop through the Tiller Hub, the experience is much better connecting from a local terminal using the Tiller CLI.

1. `npm install -g @paperwing-dev/tiller`
2. Run `tiller` to connect to the Hub.

## Requirements

Every Tiller installation has one Hub on its exact protected workers.dev
hostname. New workloads run on the execution backend selected in Settings:
Cloudflare Containers by default, or Your machine after it is explicitly
connected and selected.

**Required**

1. Cloudflare account. Cloudflare Containers require the applicable paid plan.
2. Github account.

**Optional**

1. API or subscription credentials for Claude or Codex.
2. A Linux or macOS machine with Docker if you want workloads to use Your
   machine. Run the full command shown in Settings:
   `tiller host setup --hub-url https://<exact-host>.workers.dev`.

## Q and A

### Why Cloudflare?

Workers are a great fit for vibe coded apps, and they provide a lot of primitives for building whatever. @korinne also works there.

### Can Multiple Users Connect to the Hub?

Tiller is meant for only a single user. The subscription terms for OpenAI and Anthropic are explicit about this, and we haven't handled any of the security concerns associated with multiple users.

### What about OpenCode/PI?

We're working on it! OpenCode is an implementor, but making it work everywhere is going to be a beta feature.

### Can I Only Develop Cloudflare Apps?

No, any language and ecosystem can work. We have the containers only setup to support Javascript/ npm right now, and the MCP server auth only works for Cloudflare. This may expand to support more than Cloudflare, or get more Cloudflare specific when we starting adding secrets, deployment previews, and other features.

### Why Use Containers for Planning/ Review Flows?

Original versions of this app used a worker and implemented our own minimal planning and review harnesses for the "chat reviewers". This is a cleaner solution that saves on container costs, and is architecturally simpler. However Claude subscriptions only work with Claude Code, and we still need that functionality for now. Also for large codebases, a container performed better, but this may have changed.

### Your Calling Out To auth.paperwing.dev?!

Yes, only once during the onboarding flow. Onboarding would have been a huge UX pain otherwise, and a pre-registered callback URL is required for Cloudflare OAuth. There is no tracking in the app. It's all on your personal cloudflare account beside this check, and optional updates which you can turn off.

## Contributing

This is the Tiller release channel. This repo is required due to limitations of the "Deploy to Cloudflare" button, as it can't handle monorepos.

For active development, the monorepo with the rest of the packages will be uploaded when things stabilize with the beta version. Expect this mid August. Contributions will be accepted then.
