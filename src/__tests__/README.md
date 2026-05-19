# Frontend Tests

This folder contains grouped frontend unit tests for Tiller Hub.

## Purpose

Right now this mostly covers small client-side state helpers, but the folder exists so frontend tests have a predictable home as the UI grows.

## Why this folder exists

The frontend tests were previously mixed into the main `src/` tree. Grouping them under `src/__tests__/` reduces noise when browsing the UI code and matches the same cleanup pattern used for the API side.

This is mostly an organization choice: production UI components stay easy to scan, while tests still live close to the package they validate.
