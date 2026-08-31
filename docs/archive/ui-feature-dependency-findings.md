# UI Feature Dependency Findings

This note summarizes T3 Code patterns and the closest Svelte 5 choices. The T3 Code comparison uses commit [`5719e8a`](https://github.com/pingdotgg/t3code/tree/5719e8ac4020dda0e375ef61d044b61f55a0df8a).

## Recommendation

Keep the Pidex renderer Svelte-only. Use vanilla or framework-neutral packages directly, and replace only React-specific adapters.

| Feature         | T3 Code                                                       | Svelte 5 choice                                                                |
| --------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Terminal        | `@xterm/xterm`, fit addon, and server-side `node-pty`         | Use the same packages; mount and dispose xterm from a Svelte attachment.       |
| Diff view       | `@pierre/diffs` with its React adapter                        | Use the vanilla `@pierre/diffs` API from a Svelte attachment.                  |
| File tree       | `@pierre/trees/react`                                         | Use the vanilla `@pierre/trees` model; it is designed for non-React hosts.     |
| Browser         | Electron `<webview>`, preload/IPC, CDP, and `playwright-core` | Keep this in Electron; the Svelte UI only controls it through the preload API. |
| UI icons        | `lucide-react` plus custom inline SVG components              | Use `@lucide/svelte` plus local Svelte SVG components for brand icons.         |
| Floating search | Custom palette built on Base UI dialog and autocomplete       | Use Bits UI `Dialog` and `Combobox`; keep filtering and result data app-owned. |

`@pierre/diffs` and `@pierre/trees` both provide vanilla JavaScript runtimes, so a React compatibility layer is unnecessary. Trees is still beta and should be pinned exactly if adopted.

## In-app browser and annotation

T3 Code has a real in-app browser. It uses an Electron guest webview and a restricted preload bridge, while `playwright-core` supplies browser automation primitives.

Its injected annotation UI supports element and area selection, multiple targets, freehand marks, comments, temporary style changes, selectors, element context, and a cropped screenshot. The result is attached to the chat prompt.

For Pidex, copy the architecture rather than the React UI: keep navigation and capture in Electron, render controls in Svelte, and pass validated annotation payloads through the narrow preload boundary.

## React Grab equivalent for Svelte

[`element-source`](https://github.com/aidenybai/element-source) is the best open-source building block. It is MIT licensed, comes from React Grab's author, supports Svelte, and resolves a DOM element to its component, source location, and component stack.

It is not a complete Svelte Grab. Pidex would still own the hover overlay, selection state, annotation editor, screenshot flow, and prompt formatting. Svelte's official [Vite Inspector](https://github.com/sveltejs/vite-plugin-svelte/blob/main/docs/inspector.md) is useful for development-time inspect-and-open-source behavior only.

## Scope

These features remain outside the current Pidex v1 scope. This document records future dependency choices; no packages should be installed until a feature is accepted into the product scope.

## References

- [T3 Code web dependencies](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/apps/web/package.json)
- [T3 Code annotation preload](https://github.com/pingdotgg/t3code/blob/5719e8ac4020dda0e375ef61d044b61f55a0df8a/apps/desktop/src/preview/PickPreload.ts)
- [xterm.js documentation](https://xtermjs.org/docs/)
- [Pierre Diffs vanilla API](https://diffs.com/docs)
- [Pierre Trees vanilla API](https://trees.software/docs)
- [Bits UI Combobox](https://www.bits-ui.com/docs/components/combobox)
- [Lucide for Svelte](https://www.npmjs.com/package/@lucide/svelte)
