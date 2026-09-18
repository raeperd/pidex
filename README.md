# pidex

This branch resets pidex to a minimal pnpm workspace. The web package builds a static
SvelteKit page. There is no agent integration, server, database, or desktop runtime.

Use Node.js 24 and pnpm 11.16.0:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

## Workspace

```text
packages/
├── api/src/       # Empty; reserved for shared contracts
├── desktop/src/   # Empty; reserved for the desktop entry point
├── server/src/    # Empty; reserved for the server
└── web/           # Minimal SvelteKit page and build configuration
```

Add dependencies when their implementation needs them. The empty directories have
no package manifests or build steps yet. [Product requirements](docs/prd.md) remain
as a reference for deciding what to rebuild.

## Validation

```sh
pnpm lint
pnpm test
pnpm build
```

CI runs these commands after a frozen-lockfile install. `pnpm build` writes the web
app to `packages/web/dist`. Run `pnpm --filter @pidex/web preview` to view that build.

There are no behavior tests yet. Vitest discovers `packages/**/*.test.ts` and
explicitly allows an empty suite during the reset. Remove `passWithNoTests` from
`vitest.config.ts` when adding the first behavior test. A passing test command at
this stage does not verify application behavior.

`pnpm check` also checks formatting and web types. Use `pnpm format` to format files.
