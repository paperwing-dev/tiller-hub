# Workspace

This folder contains the hosted workspace storage layer and the routes that expose it.

## Purpose

`workspace/` owns:

- the `WorkspaceDO`
- the workspace host adapter used by `agents/experimental/workspace`
- file and plan materialization API routes

## Why this folder exists

Workspace state was split away from container lifecycle on purpose.

That decision is important for Tiller:

- runners can be local or Cloudflare-backed
- workspace state stays hosted
- hosted agents like Research can still work without a live container

Putting these files together makes that boundary much clearer:

- `workspace/` is durable project state
- `env/` is execution lifecycle

That separation is one of the core architectural decisions in the current Tiller design.
