# Preserve unsent composer drafts across switching and relaunch

## Description

Restore composer drafts for saved sessions and session drafts. Supplemental context: [v0.0.2 spec](../../../docs/v0.0.2-tech-spec.md).

- Web owns editable text; Desktop extends its versioned userData metadata file with atomic writes. Use authenticated APIs and typed Effect failures. Key composer drafts by canonical project and stable Pi session identity so they survive replacement of the live `AgentSession`; map local session draft identities to saved Pi sessions without loss. Pi owns history; no transcript copies, database, or credentials.
- Flush before switching, ordinary window close, or Quit. Window close leaves any active run running. Failed writes keep text editable; leaving requires explicit discard. Preserve unreadable metadata and show an error. Abrupt termination guarantees only flushed text.
- Clear only accepted text; retain later edits and rejected or uncertain submissions until reconciled. Acceptance differs from run completion; restoration never sends.
- Draft transfer or recovery after missing Pi history causes a fresh session is outside this issue. Retain the v0.0.1 crash-recovery behavior.

Blocked by: [Switch projects and sessions](05-switch-projects-and-sessions.md) for navigation and selection, and inherited Desktop metadata storage.

## Acceptance criteria

- [ ] Given real Electron/Pi, two temporary projects/sessions, isolated metadata, and a controlled provider, when distinct composer drafts are typed, switched, and restored after Quit/relaunch, then each retains its own text with zero provider requests during restoration.
- [ ] Given unsent composer text in an idle or running session, when the window closes and the app reactivates, then the text is restored without submission; an active run continues without cancellation. Repeat before a new session's first send.
- [ ] Given a session draft with unsent composer text, when switching/relaunching and later sending creates its saved Pi session, then text survives restoration and identity mapping without loss or duplication.
- [ ] Given edits during delayed acknowledgement, pre-acceptance rejection, or network acknowledgement loss, when submission settles or reconnects, then only confirmed submitted text clears, later edits remain, and uncertain sends reconcile before retry without duplicate submission.
- [ ] Given real metadata write failures or unreadable files, when switching, closing the window, quitting, or restoring, then actionable errors preserve editable text and corrupt files; leaving after a failed write requires explicit discard.
- [ ] Given flushed and pending edits, when Electron terminates abruptly and relaunches, then flushed text survives without automatic submission; pending edits may be lost.
