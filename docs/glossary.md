# Pidex glossary

Pi terminology is authoritative for agent execution and persistence. Pidex adds project navigation and session-owned UI metadata and resources. These definitions follow the installed Pi 0.85.1 SDK; verify them when upgrading Pi.

| Term                    | Meaning                                                                                                                                | Pi mapping                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Project                 | Pidex's grouping for a selected canonical directory and multiple sessions.                                                             | Project context rooted at `cwd`; Pidex owns recent-project metadata.                              |
| Working directory       | The directory used for tools and project-resource discovery.                                                                           | `cwd`                                                                                             |
| Session                 | A Pidex work context backed by one native Pi session, with supporting UI metadata and resources.                                       | One-to-one with a Pi session; Pidex metadata stays separate from Pi history.                      |
| Pi session              | The native conversation identity and history backing a Pidex session.                                                                  | `sessionId`, `SessionManager`                                                                     |
| Session file            | Pi-owned JSONL history. A new session can exist before its file is written.                                                            | `sessionFile`                                                                                     |
| Active session          | The live session handling prompts, messages, model state, and events.                                                                  | `AgentSession`                                                                                    |
| Session runtime         | The owner that replaces the active session and rebuilds services tied to the working directory.                                        | `AgentSessionRuntime`                                                                             |
| Prompt                  | User input submitted to the active session.                                                                                            | `session.prompt(...)`                                                                             |
| Run                     | Pidex's execution of one accepted prompt through completion, failure, or cancellation, including retries and any turns it requires.    | The accepted `prompt()` execution, rather than a single low-level `agent_start`/`agent_end` pair. |
| Turn                    | One model response and its tool calls. A run may contain multiple turns.                                                               | `turn_start`, `turn_end`                                                                          |
| Provider                | The model inference provider, such as Anthropic or OpenAI.                                                                             | Model provider; Pi itself is the coding agent.                                                    |
| Model                   | The selected model identified within a provider.                                                                                       | `Model`, provider/model ID                                                                        |
| Tool call / tool result | A requested tool operation and its output.                                                                                             | Tool execution events and tool-result messages                                                    |
| Context files           | Instruction files discovered for the session, such as `AGENTS.md`.                                                                     | `ResourceLoader` context files                                                                    |
| Transcript              | The UI rendering of the selected session's messages and tool activity.                                                                 | Derived from Pi history and live events.                                                          |
| Panel                   | A supporting UI view belonging to one Pidex session. A panel may display a resource with its own lifecycle.                            | Pidex UI; not a Pi session or SDK resource type.                                                  |
| Composer                | The UI where the user edits and submits a prompt.                                                                                      | Pidex UI; analogous to Pi's editor.                                                               |
| Composer draft          | Unsent editable text associated with a session or session draft.                                                                       | Pidex-owned metadata; restoring it never submits it.                                              |
| Session draft           | A locally identified new-session entry before saved Pi history is available. Its composer draft survives mapping to the saved session. | Pidex-owned identity; not a separate Pi SDK session type.                                         |
| Session locator         | The project and exact Pi session information needed for recovery, including its file location when available.                          | `cwd`, `sessionId`, `sessionFile`                                                                 |

## Session ownership

- A project can contain multiple Pidex sessions. Each Pidex session maps to one native Pi session; Pidex owns its UI metadata while Pi owns conversation history and agent execution. Session drafts retain a local identity until they can map to saved Pi history.
- Associate composer drafts, panel state, and supporting resources with the stable session identity. Recreating an `AgentSession` for the same Pi session does not create a new Pidex session or change those associations.
- Future file-tree panels, browser tabs, and terminals belong to one session. Pidex owns their UI state and any browser or terminal resources separately from Pi. Adding them requires an explicit policy for what continues, suspends, or closes on switching, panel closure, and Quit; selection alone does not define resource lifetime. These features are outside v0.0.1 and v0.0.2.
- Project and Session are the product containers. Use task for a user's objective, not a separate product container.

## Actions and lifecycle

- **New session** creates a fresh active session through the session runtime. **Resume session** selects saved history and replaces the active session through the same owner. Neither action sends a prompt.
- **Send** accepts a prompt and starts a run. Acceptance is distinct from completion; composer text clears only after confirmed acceptance.
- **Stop** cancels the active run and waits for cancellation. It preserves the session and does not undo tool changes.
- A Pi turn ending does not finish a Pidex run. A low-level `agent_end` can also precede automatic retries or continuation; run completion must account for the full accepted prompt execution.

## References

- [Pi 0.85.1 SDK](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/sdk.md): sessions, runtime replacement, prompting, providers, and resources.
- [Pi 0.85.1 lifecycle events](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md#agent_start--agent_end--agent_settled): low-level runs, automatic continuation, and turns.
