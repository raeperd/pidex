---
name: electron
description: Build secure Electron applications; load when editing the main process, BrowserWindow lifecycle, preload bridges, IPC handlers, navigation policy, desktop packaging, or Electron integration tests.
---

Keep privileged Electron capabilities behind a narrow, validated process boundary.

## Process

1. Identify processes and the installed version.
   - Read the Electron version and installed type declarations before using current docs.
   - Classify affected code as main, preload, renderer, utility, or packaging code.
   - Trace window ownership, IPC channels, and shutdown behavior.
   - Completion: every changed capability has one owning process and lifecycle.

2. Compose the main process.
   - Wait for `app.whenReady()` before creating windows or using ready-only APIs.
   - Register IPC handlers before loading renderer content that can call them.
   - Keep window construction, application services, and cleanup in one composition root.
   - Follow platform lifecycle conventions for activation and all-windows-closed events.
   - Completion: startup and shutdown order are deterministic on each target platform.

3. Harden each renderer.
   - Keep `contextIsolation`, sandboxing, and disabled Node integration enabled.
   - Load local packaged content or trusted HTTPS content with a restrictive CSP.
   - Deny or constrain unexpected navigation, new windows, and permission requests.
   - Validate external URLs before passing them to `shell.openExternal`.
   - Completion: renderer content cannot acquire undeclared native capabilities.

4. Design the preload bridge.
   - Expose small capability methods with `contextBridge.exposeInMainWorld`.
   - Wrap one approved IPC channel per method instead of exposing `ipcRenderer`.
   - Strip the Electron event object before invoking renderer callbacks.
   - Add renderer-facing TypeScript declarations for the exposed API.
   - Completion: the bridge is typed, minimal, and contains no raw privileged object.

5. Validate IPC in the main process.
   - Use `ipcMain.handle` with `ipcRenderer.invoke` for request-response operations.
   - Validate payloads, authorization, and `event.senderFrame` at the privileged boundary.
   - Return serializable values and map internal failures to stable public errors.
   - Remove handlers and listeners when their owning service is disposed.
   - Completion: untrusted renderer input cannot select arbitrary native operations.

6. Verify desktop behavior.
   - Unit-test pure validation and lifecycle decisions outside Electron where practical.
   - Add integration coverage for preload exposure, IPC, window creation, and shutdown.
   - Exercise both development URLs and packaged file or custom-protocol loading.
   - Check platform-specific paths on every supported operating system.
   - Completion: tests cover the real process boundary and cleanup path.

## Official references

- [Process model](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Preload scripts](https://www.electronjs.org/docs/latest/tutorial/tutorial-preload)
- [Context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
- [IPC](https://www.electronjs.org/docs/latest/tutorial/ipc)
- [Security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
