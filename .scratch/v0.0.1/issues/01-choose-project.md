# 01 — Choose a project with existing Pi setup

## Description

Choose a project and see a fresh, idle Pi conversation with the resolved default model.

- The repository is a skeleton. Build a macOS development app with Electron main, Svelte renderer, and one owned backend child embedding Pi. Main owns windows, folder selection, child lifetime, credentials, and the exact session locator; backend owns Pi/history; renderer imports browser-safe shared API definitions, never backend code.
- Use Effect backend logic and Effect RPC/Schema over loopback HTTP/WebSocket, per-launch authentication, approved origins, and narrow native preload capabilities. Keep credentials out of the renderer/logs and composition at process entry points.
- Pin compatible Playwright/Electron versions; consider WebdriverIO if a required testing capability is missing.
- Pin the latest stable Pi SDK. Reuse normal credentials/default-model resolution, stock tools, and project instructions. Disable external extensions, skills, templates, themes, custom system prompts, and package resources without editing user configuration.
- Keep one project/session until exit. Pi JSONL is authoritative, with no separate database; no file need exist before the first assistant message. This slice ends at idle startup/shutdown; streaming, Stop, crash recovery, and busy Quit belong elsewhere.

Reference: [v0.0.1 technical spec](https://github.com/raeperd/pidex/blob/docs/v0.0.1-tech-spec/docs/v0.0.1-tech-spec.md)

## Acceptance criteria

- [ ] Given the project chooser, when the preconfigured native dialog returns Cancel, then the chooser remains available and no conversation appears.
- [ ] Given cancellation and usable temporary Pi credentials/default-model configuration, when the next native dialog returns a temporary project, then the UI shows a fresh empty conversation, Idle status, and the configured model name.
- [ ] Given that idle conversation, when Quit is requested, then Electron and its owned backend child exit, observed through process termination.
