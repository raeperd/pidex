# 08 — Handle missing or unreadable session files

## Description

Explain missing history and preserve unreadable files during recovery.

- Electron main retains the exact Pi JSONL locator across crashes. Restart creates one child embedding Pi SDK and attempts that file, never silently choosing another existing session. Keep the same project and one active conversation.
- Pi JSONL is authoritative; interrupted first turns may lack files. Distinguish absence from access/read errors; never automatically restart, replay prompts, or overwrite history.
- Effect backend logic returns typed recovery errors through authenticated loopback Effect RPC/Schema to the Svelte UI.

Blocked by: [#135 — Recover the saved session after a backend crash](https://github.com/raeperd/pidex/issues/135), for Restart.

Reference: [v0.0.1 technical spec](https://github.com/raeperd/pidex/blob/docs/v0.0.1-tech-spec/docs/v0.0.1-tech-spec.md)

## Acceptance criteria

- [ ] Given a saved turn, when the owned child is killed, its exact file removed, and Restart clicked, then the UI explains missing history and shows a distinct, idle conversation in the same project. No provider request occurs.
- [ ] Given a first prompt held before any assistant message/file, when the child is killed and Restart clicked, then the UI explains a fresh start and allows Send without replay or eager persistence.
- [ ] Given recorded session bytes, when the child is killed and filesystem permissions deny its replacement read access, then clicking Restart shows an actionable error and preserves the file without replacement. Verify child access fails, without stubbing the loader; restore access and compare bytes during cleanup.
