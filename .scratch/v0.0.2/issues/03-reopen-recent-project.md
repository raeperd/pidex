# Reopen a project from recent projects

## Description

Launch into recent projects with a native folder-picker option. Opening shows the project's conversations; resuming remains explicit. Assume the completed [v0.0.1 baseline](../../../docs/v0.0.1-tech-spec.md) and follow the [v0.0.2 spec](../../../docs/v0.0.2-tech-spec.md).

- Desktop owns native selection, canonical recent paths, and a versioned metadata file under Electron userData with atomic replacement. Reuse canonical identity to deduplicate aliases. Allow later draft metadata; draft persistence belongs elsewhere.
- Web owns recent-project navigation and opening project history. New and Resume belong to separate issues. Use validated identities, Effect application effects, and typed failures across the authenticated boundary. Pi owns history.

Blocked by: [List saved conversations](01-list-project-conversations.md), which supplies the selected project's history view.

## Acceptance criteria

- [ ] Given visible macOS Electron with real preload, server, transport, and Pi, isolated projects, sessions, credentials, and metadata, and controlled native dialogs/provider responses, when a folder is selected, then its conversation list opens without a provider request.
- [ ] Given a previously opened project, when the app quits and relaunches, then recent choices appear without resuming; selecting that project opens its history with zero provider requests.
- [ ] Given a recent project, when its canonical directory is chosen through a path alias, then only one recent entry remains.
- [ ] Given a missing recent folder, when selected, then an actionable error appears and its entry remains available.
- [ ] Given recent choices, when the folder picker is cancelled, then selection and recent entries remain unchanged.
