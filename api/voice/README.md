# Voice

This folder contains the voice-specific transport and agent code.

## Purpose

`voice/` groups the voice stack together:

- the main voice agent
- WebSocket/HTTP voice routes
- SFU-specific route and Durable Object code

## Why this folder exists

Voice code is its own subsystem. It has different concerns from the rest of Tiller:

- realtime audio transport
- speech-to-text / text-to-speech
- SFU session negotiation
- voice-specific agent behavior

Leaving these files in the API root made the rest of the app look more entangled than it really is. Moving them into `voice/` makes that subsystem boundary obvious and keeps the non-voice API easier to scan.

## Design note

The voice stack is intentionally separate from the hosted Research/Planner/Reviewer chat agent work. They may share some product concepts, but they are different runtime and transport systems.
