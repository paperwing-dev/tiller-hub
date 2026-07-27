# Environment API

This folder contains environment lifecycle and runner backend logic.

## Purpose

`env/` owns the parts of Tiller that manage runnable environments:

- create/start/stop/delete routes
- status normalization
- slug generation
- container auth resolution
- runner backend selection
- Cloudflare vs host runner implementations

## Why this folder exists

Environment management had grown into several loosely related files in the API root:

- route handlers
- status helpers
- auth helpers
- backend implementations

Those files all belong to the same domain. Grouping them here makes the structure easier to understand:

- `routes.ts` is the public environment API surface
- supporting files in the same folder are the lifecycle and backend mechanics behind it

This also reflects a real architectural choice in Tiller:

- workspace state is hosted separately
- execution is a pluggable backend

So the `env/` folder is specifically about runner lifecycle, not workspace storage or agent chat.
