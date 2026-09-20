# 12 — Reject unauthorized backend clients

## Description

Prevent unauthorized local clients from controlling Pi or reading the conversation.

- Electron main owns one backend child embedding Pi. Effect backend logic serves browser-safe Effect RPC/Schema over loopback HTTP/WebSocket. Narrow preload exposes native capabilities; credentials stay in main/backend, never renderer or logs.
- Startup already requires per-launch credentials and approved origins. Verify this policy and fix gaps. Pi JSONL remains authoritative.
- This use case starts from an independent API client against the full app, with real transport/handlers/Pi and no HTTP mocks.

Blocked by: [#130 — Stream replies and tool activity](https://github.com/raeperd/pidex/issues/130), for working prompts and subscriptions.

Reference: [v0.0.1 technical spec](https://github.com/raeperd/pidex/blob/docs/v0.0.1-tech-spec/docs/v0.0.1-tech-spec.md)

## Acceptance criteria

- [ ] Given a launched app, selected project, and idle saved conversation, when an independent client submits Send and Watch with absent or wrong credentials and an approved Origin, then reject before Pi work or snapshot/update delivery. UI conversation, saved JSONL bytes, and provider invocation count remain unchanged.
- [ ] Given that session and valid credentials, when the independent client repeats those requests with an unapproved Origin, then reject with no conversation/history change, provider invocation, or subscription data.
- [ ] Given valid credentials and an approved Origin, when the control client watches and sends "Reply hello", then it receives the conversation and reply "hello". Provider invocation count increases once; blanket rejection fails this control.
