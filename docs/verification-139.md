# Stock Pi acceptance, #139

Use Node 24, pnpm 11.16.0, and macOS. The lockfile pins Pi 0.85.1, Electron 44.4.3, and Playwright 1.63.0.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test --grep '#139'
# Run one instruction variant:
pnpm exec playwright test --grep '#139.*CLAUDE'
# Step through the visible Electron app:
pnpm build && pnpm exec playwright test --grep '#139.*AGENTS' --debug
```

Each scenario creates a temporary home, project, Pi configuration, credentials, local packages, and Chromium profile. No personal configuration or paid provider is used. Only native folder-dialog results and model responses are controlled. The real composer, preload, authenticated transport, backend, SDK resource loading, and stock tools run unchanged.

The AGENTS.md fixture also contains a CLAUDE.md file whose sentinel must be absent, matching Pi's preference for AGENTS.md within one directory. The separate CLAUDE.md fixture has no project AGENTS.md. Both include global and parent instructions. After Choose project and Send, every captured provider request must contain PROJECT_RULE_11 and the inherited instructions.

Excluded resources have unique sentinels in global and project discovery directories, explicit settings paths, and local packages. Package settings cover both string and object entries with resource filters. Skills also occupy home and project `.agents/skills` directories. Both global and project SYSTEM.md and APPEND_SYSTEM.md files are present. The composer sends `/global-prompt` to catch unintended template expansion. Every provider request must exclude all customization sentinels and advertise exactly read, bash, edit, and write. An extension writes a marker if executed; that marker must remain absent.

V8 coverage from the real backend supplements the behavioral checks: extension loading, skill/template/theme loading, and package resource collection must have zero calls. This catches dormant resources that would never appear in provider text, including packages resolved before Pi applies its resource filters. Coverage function names follow the pinned SDK and may need updating with an SDK upgrade; no SDK functions are replaced. All fixture file bytes, including both settings files and credentials, are compared after graceful Quit and settings flush.

The local provider requests write of `hello` to note.txt, read, edit to `goodbye`, and bash `cat note.txt` in separate sequential turns. The test expands the four visible tool panels and checks their order, inputs, and results; the provider's next turns must receive those real results. Final file bytes must be exactly `goodbye`, and status must be Idle.

Artifacts live under `test-results/stock-pi-*/`: `stock-tools.png`, `trace.zip`, and `resource-coverage.json`. Failures also save `failure.png` when the window remains open and `electron.log` with the temporary path redacted. Open a trace with `pnpm exec playwright show-trace <trace.zip>`. Include #139, the pinned versions, the rerun command, and expected versus actual behavior when reporting a failure.
