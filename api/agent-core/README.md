# Agent Core

This folder contains the hosted-agent harness retained for the unrouted legacy
`ReviewerChatAgent`.

## Purpose

`agent-core/` supports the preserved reviewer class in `api/agents/`. Current
reviewer tabs use planner runs instead, and the Worker does not dispatch
`/agents/*` requests to this harness.

It owns things like:

- the exact retained reviewer spec
- read-only `read_file`, `list_files`, and `glob` tools
- reviewer prompt/context building

## Notes

- Keep this code buildable while `ReviewerChatAgent` remains in deployed
  Durable Object topology.
- Do not add new product flows here; new planning and review behavior belongs
  under `api/planner/`.
