# 04 — Stop a run and continue the conversation

## Description

Stop Pi and continue the same conversation without losing available work.

- Electron/Svelte sends the observed run's identity through authenticated loopback Effect RPC/Schema to one backend child embedding Pi. Effect backend logic owns runs independently of watchers; Stop awaits Pi cancellation acknowledgment.
- One project/session remains active. Pi JSONL is authoritative; cancellation preserves saved history and available partial UI output, but unfinished tokens may be unsaved and an interrupted first turn may lack a file. Tool edits remain; Stop never rolls them back.

Blocked by: [#130 — Stream replies and tool activity](https://github.com/raeperd/pidex/issues/130), for streamed runs and tools.

Reference: [v0.0.1 technical spec](https://github.com/raeperd/pidex/blob/docs/v0.0.1-tech-spec/docs/v0.0.1-tech-spec.md)

## Acceptance criteria

- [ ] Given text "Working" and a tool edit setting note.txt to "hello", when Stop reaches a controlled-provider cancellation gate, then show Stopping while acknowledgment is held, keep drafts editable, and disable Send. When the gate releases acknowledgment, then show Idle, retain available output/history, and verify note.txt contains "hello".
- [ ] Given acknowledged cancellation, when the user sends "Continue", then the same Pi session accepts it and displays the controlled reply "Continued", returning to Idle.
- [ ] Given a later active run, when repeated or delayed authenticated Stop requests target the earlier run, then the later run completes normally. Supplement the UI scenario with this real-transport #132 check.
