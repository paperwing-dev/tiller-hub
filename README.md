# Tiller

Tiller is our personalized vibe coding platform built with Cloudflare primitives. It recreates the portions of Claude Code and Codex that we find useful, and adds more control and observability. Use your Claude Code/ Codex subscriptions, run on your own server or Cloudflare Containers, and customize however you like.

## Getting Started

1. Have a Paid $5 Cloudflare account and Github account.
2. Deploy the hub into your Cloudflare account using the "Cloudflare Deploy" button.
3. Follow the github setup wizard.

[![Deploy Tiller](public/deploy-tiller.svg)](https://install.paperwing.dev/deploy)

## Current Status

This package is currently in Alpha. We are using it to dogfood Tiller, but we are still adding performance updates, underlying features are changing, and designs are updating. Assume settings and plans might not carry over to beta.

It's working pretty well though. Give it a whirl.

## Q and A

### Why Cloudflare?

Workers are a great fit for vibe coded apps, and they provide a lot of primitives for building whatever. @korinne also works there.

### Where Is The Full Monorepo?

We use the monorepo packages in other private apps, and it would take some effort to untangle them. This is simply our dev "hub", and uploaded as a reference for how you can build on Cloudflare.

If there is interest in the full source, we're open to releasing that. It might look like asking contributors to sign a CLA, or breaking portion out into an MIT license. For most people wanting to customize though, the "hub" code is all you need. If you need full control, it should also be pretty easy to reverse engineer packages with AI. The hub is the bulk of the code.

### Can Multiple Users Connect to the Hub?

Tiller is meant for only a single user. The subscription terms for OpenAI and Anthropic are explicit about this, and we haven't handled any of the security concerns associated with multiple users.

### Why Use Containers for Planning/ Review Flows?

Original versions of this app used a worker and implemented our own minimal planning and review harnesses for the "chat reviewers". This is a cleaner solution that saves on container costs, and is architecturally simpler. However Claude subscriptions only work with Claude Code, and we still need that functionality for now. Also for large codebases, a container performed better, but this may have changed.

### Why Does Tiller Use An Installer at "install.paperwing.dev"?

Originally this used the "Deploy to Cloudflare Button". However, onboarding was a large UX pain, and a pre-registered callback URL is required for Cloudflare OAuth. There is no tracking in the app. It's all on your personal Cloudflare account beside the install and updates.

## Contributing/ License

Tiller is free software under the [GNU Affero General Public License v3.0 or later](LICENSE). You can use Tiller personally, inside a company, modify it, fork it, redistribute it, but must make your updates open source under AGPL. This also goes for if you operate a modified version over a network.

For now, contributions are not being accepted. This is again, a tool personalized for us, and we are still figuring out how we want to handle open source. Will have a better plan by beta.
