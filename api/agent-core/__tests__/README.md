# Agent Core Tests

This folder contains tests for the shared hosted-agent harness.

## Purpose

These tests cover the reusable pieces in `agent-core/`, such as:

- tool definitions
- context building
- specs
- Codex/request helpers

## Why this folder exists

`agent-core/` is meant to be reusable infrastructure, so it benefits from tests that are grouped and easy to scan as a set.

Keeping these tests under `agent-core/__tests__/` reinforces that `agent-core/` is a coherent subsystem with its own behavior, not just a loose collection of helper files.
