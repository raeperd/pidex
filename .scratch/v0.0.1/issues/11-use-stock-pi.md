# 11 — Use stock Pi with project instructions

## Description

Send with project instructions and stock Pi tools, without loading external customization.

- Electron/Svelte sends through authenticated loopback Effect RPC/Schema to one backend child embedding Pi. Backend logic uses Effect. Keep normal credentials/default-model resolution, stock read/bash/edit/write tools, retry, compaction, and project instructions.
- Disable external extensions, skills, templates, themes, custom system prompts, and package resources, including effective package resource settings, without modifying user configuration. This verifies existing startup policy; fix only exposed gaps.

Blocked by: [#130 — Stream replies and tool activity](https://github.com/raeperd/pidex/issues/130), for Send and visible tool results.

Reference: [v0.0.1 technical spec](https://github.com/raeperd/pidex/blob/docs/v0.0.1-tech-spec/docs/v0.0.1-tech-spec.md)

## Acceptance criteria

- [ ] Given a project with sentinel "PROJECT_RULE_11" in project instructions, when the user selects it and sends through the composer, then actual provider input includes the sentinel after real SDK loading. Use separate AGENTS.md and CLAUDE.md fixtures under stock loading rules.
- [ ] Given excluded resources with unique sentinels in temporary project/configuration/package locations, when it opens and Send runs, then none load or reach provider input and configuration bytes remain unchanged. Exclude personal configuration.
- [ ] Given controlled tool requests, when Send runs, then write creates note.txt with "hello", read returns "hello", edit replaces it with "goodbye", and bash reads "goodbye" in the selected directory. Observe tool inputs/results, final file bytes "goodbye", and Idle.
