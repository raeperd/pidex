# 02 — Stream replies and tool activity

## Description

Send a prompt and follow streamed replies and tool activity.

- #129 supplies project selection and an idle session with the resolved model. Electron/Svelte uses authenticated loopback Effect RPC/Schema to one backend child embedding the real Pi SDK; backend logic uses Effect.
- Backend owns runs independently of watchers. Watch sends a snapshot then ordered updates without gaps. Send atomically accepts nonempty input only while idle; disable Send while busy.
- Pi JSONL is authoritative, with no separate database. Verify saved history after the completed turn; no file is required before the first assistant message.

Blocked by: [#129 — Choose a project with existing Pi setup](https://github.com/raeperd/pidex/issues/129), for project/session setup.

Reference: [v0.0.1 technical spec](https://github.com/raeperd/pidex/blob/docs/v0.0.1-tech-spec/docs/v0.0.1-tech-spec.md)

## Acceptance criteria

- [ ] Given an idle session and controlled model responses, when the user sends "Write hello to note.txt", then Pi's real write tool creates note.txt containing exactly "hello". Show partial text before completion, ordered tool inputs/results in expandable panels, and final text "Saved hello" with "hello" bold, then Idle and saved Pi history.
- [ ] Given idle, when an empty or whitespace-only prompt reaches Send, then the backend rejects it without provider requests.
- [ ] Given an active controlled response, when an authenticated second submission arrives, then the backend rejects it without another provider request. Send stays disabled until idle.
