## Description

Coordinate switching across projects and sessions without quitting. Requires the completed [v0.0.1 baseline](https://github.com/raeperd/pidex/blob/fbc2264532158f411ac3dc24893be94d32adffc7/docs/v0.0.1-tech-spec.md). Supplemental context: [v0.0.2 spec](https://github.com/raeperd/pidex/blob/fbc2264532158f411ac3dc24893be94d32adffc7/docs/v0.0.2-tech-spec.md).

- The renderer owns the selected project and session. Switching reads the target's transcript and never replaces server state. Each Send names its target locator; the server validates it and opens the Pi session with the destination's working directory, context files, and tools for that run only.
- Use Effect with typed failures and retain authentication/resource restrictions. Allow one run at a time: the server rejects Send during a run, and the UI disables switching during Running and Stopping. Events carry the run ID and target; the renderer ignores events for other targets.
- A failed transcript read or invalid target shows an actionable error and keeps the previous selection usable; preserve existing files. Composer draft persistence belongs to the next issue.

Blocked by: [New session](https://github.com/raeperd/pidex/issues/192) for fresh-session replacement; [Recent projects](https://github.com/raeperd/pidex/issues/193) for project navigation; [Resume session](https://github.com/raeperd/pidex/issues/194) for saved-session replacement.

## Acceptance criteria

- [ ] Given visible macOS Electron using real preload/transport/server/Pi, two temporary projects with distinct instructions/histories, and controlled provider responses, when users switch idle sessions/projects through New session and Resume session, then captured requests contain selected history/instructions and real tool filesystem results prove the selected working directory.
- [ ] Given a running or stopping session, when switching is attempted, then navigation is disabled and supplemental API checks reject a competing Send without changing selection.
- [ ] Given events from a previous target or a request naming another target, when switching completes, then those events cannot alter the selected transcript and every Send reaches only the target it names.
- [ ] Given an unavailable destination folder/session file, when UI and supplemental API checks attempt switching, then an actionable error preserves files and the last selection; previous work remains usable or Retry appears with Send disabled.

