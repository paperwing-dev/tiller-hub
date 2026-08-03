# Agent Core Tests

This folder contains tests for the hosted-agent harness retained by the
unrouted `ReviewerChatAgent`.

## Purpose

These tests cover the retained pieces in `agent-core/`, such as:

- read-only reviewer tool definitions
- context building
- the reviewer spec

## Why this folder exists

These tests keep the dormant reviewer implementation buildable while its
Durable Object class remains part of deployment topology.
