## Description

Coordinate switching across projects and sessions without quitting. Requires the completed [v0.0.1 baseline](https://github.com/raeperd/pidex/blob/fbc2264532158f411ac3dc24893be94d32adffc7/docs/v0.0.1-tech-spec.md). Supplemental context: [v0.0.2 spec](https://github.com/raeperd/pidex/blob/fbc2264532158f411ac3dc24893be94d32adffc7/docs/v0.0.2-tech-spec.md).

- Own cross-project routing; compose prerequisite operations. Keep at most one active Pi session and one run in progress in one owned server child. The session runtime replaces the active session and rebuilds resources for the destination working directory, including context files and subscriptions; Desktop commits its recovery locator only after success.
- Use Effect with typed failures and retain authentication/resource restrictions. Serialize Switch, New session, Resume session, and Send. Server/API rejects busy, stopping, and stale-target requests. Publish the selected snapshot before enabling Send; ignore previous-session events.
- Preflight destinations before releasing current work. Failure preserves the previous usable selection or offers Retry with Send disabled; preserve existing files. Composer draft persistence belongs to the next issue.

Blocked by: [New session](https://github.com/raeperd/pidex/issues/192) for fresh-session replacement; [Recent projects](https://github.com/raeperd/pidex/issues/193) for project navigation; [Resume session](https://github.com/raeperd/pidex/issues/194) for saved-session replacement.

## Acceptance criteria

- [ ] Given visible macOS Electron using real preload/transport/server/Pi, two temporary projects with distinct instructions/histories, and controlled provider responses, when users switch idle sessions/projects through New session and Resume session, then captured requests contain selected history/instructions and real tool filesystem results prove the selected working directory.
- [ ] Given a running or stopping session, when switching is attempted, then navigation is disabled and supplemental API checks reject competing Switch, New session, Resume session, and Send requests without changing selection.
- [ ] Given delayed old-session responses or stale-target requests, when switching completes, then old events cannot alter the transcript and stale requests cannot send or replace it.
- [ ] Given an unavailable destination folder/session file, when UI and supplemental API checks attempt switching, then an actionable error preserves files and the recovery locator; previous work remains usable or Retry appears with Send disabled.

