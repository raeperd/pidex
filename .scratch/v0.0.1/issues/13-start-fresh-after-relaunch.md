# 13 — Start a fresh conversation after app relaunch

## Description

Start a fresh conversation after relaunch while preserving Pi history.

- Electron main owns one backend child embedding Pi. Svelte uses authenticated loopback Effect RPC/Schema; backend uses Effect. Main retains the recovery session locator only in memory.
- Pi JSONL is authoritative, with no separate database. Full Quit starts fresh next launch. Exclude history selection and automatic last-session restoration; busy Quit belongs to #137. No file is required before an assistant message.

Blocked by: [#130 — Stream replies and tool activity](https://github.com/raeperd/pidex/issues/130), for completed turns and saved history; #129 already provides idle Quit.

Reference: [v0.0.1 technical spec](https://github.com/raeperd/pidex/blob/docs/v0.0.1-tech-spec/docs/v0.0.1-tech-spec.md)

## Acceptance criteria

- [ ] Given an idle completed turn showing "old reply", with saved JSONL bytes and session identity recorded, when full Quit is requested, then an external fixture observes the original Electron and backend PIDs exit.
- [ ] Given that exit, when new Electron/backend processes launch in the same isolated test home and the preconfigured dialog selects the same project, then the UI shows an empty conversation and Idle; previous file bytes remain unchanged.
- [ ] Given the fresh conversation, when a controlled turn completes with "new reply", then a second JSONL file records a distinct session identity and reply; the original file remains byte-for-byte unchanged.
