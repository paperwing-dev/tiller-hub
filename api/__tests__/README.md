# API Tests

This folder contains grouped tests for top-level API domains.

## Purpose

These tests cover API helpers and route modules that do not belong inside a more specific subfolder, such as:

- environment lifecycle helpers
- OpenAI auth helpers
- runner backend selection

## Why this folder exists

The tests previously sat mixed in with production files. Grouping them here makes the API folders easier to scan and keeps the production modules focused.

The rule of thumb is:

- tests for a specific subsystem live next to that subsystem's folder when useful
- otherwise they live here under `api/__tests__/`
