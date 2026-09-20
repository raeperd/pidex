# List saved sessions for the chosen project

## Description

Find saved sessions after choosing a project. Requires the completed [v0.0.1 baseline](../../../docs/v0.0.1-tech-spec.md), with folder selection, authenticated transport, and Pi persistence. Follow the [v0.0.2 spec](../../../docs/v0.0.2-tech-spec.md).

- Deliver the list through the chosen-project UI using folder selection. Recent-project navigation and Resume session are separate issues that consume its project/session identities.
- Server discovers sessions for the canonical project directory through Pi metadata/history APIs, including compatible Pi CLI histories. Pi JSONL remains authoritative; do not copy transcripts or add a database. Verify supported APIs against the installed SDK.
- Shared API validates identities, metadata, and typed failures; renderer owns list/loading/error states. Use Effect for application effects, retain authenticated transport, and keep preload limited to narrow native capabilities.

## Acceptance criteria

- [ ] Given real Electron/Pi, temporary projects, and a controlled provider, when a folder is selected, then its session list appears with zero provider requests and no automatic continuation.
- [ ] Given two projects with saved sessions, when each opens on a separate launch through folder selection or a path alias, then only its sessions appear with selectable project/session identities.
- [ ] Given compatible Pidex and Pi CLI histories, when listed, then newest activity appears first with a title or prompt preview and timestamp per entry.
- [ ] Given empty history, unreadable history, or one unreadable file among healthy sessions, when the project opens, then empty and error states differ, an actionable error identifies unreadable history, and healthy entries remain available without modifying saved files.
