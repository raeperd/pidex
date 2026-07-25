---
name: vitest
description: Test TypeScript and JavaScript with Vitest 4; load when writing tests, configuring projects or environments, using fixtures, mocking modules or time, debugging failures, or adding coverage.
---

Use installed Vitest types and Vitest 4 documentation as the testing authority.

## Process

1. Identify the test boundary.
   - Read the installed Vitest version, package scripts, and effective config.
   - Determine the test project, environment, include patterns, and setup files.
   - Read the production boundary before choosing unit or integration coverage.
   - Completion: the runner context and behavior under test are explicit.

2. Choose the smallest realistic test.
   - Prefer observable behavior through public interfaces.
   - Use real dependencies when they are fast, deterministic, and locally available.
   - Inject boundaries for clocks, randomness, networks, processes, or credentials.
   - Use temporary directories and real storage engines for persistence behavior.
   - Completion: the test isolates only boundaries that require control.

3. Structure the test lifecycle.
   - Arrange state, perform one meaningful action, and assert observable outcomes.
   - Use hooks for shared lifecycle work, not hidden per-test behavior.
   - Return or await every promise that participates in the assertion.
   - Register cleanup immediately after acquiring files, servers, handles, or timers.
   - Use fixtures with `test.extend` when typed dependencies have reusable lifecycles.
   - Completion: each test is independent and releases all acquired resources.

4. Mock deliberately.
   - Prefer `vi.spyOn` when the real module can stay loaded.
   - Remember that `vi.mock` is hoisted and its factory cannot use later variables.
   - Use `vi.hoisted` for values required by a hoisted mock factory.
   - Restore mocks, globals, environment variables, and timers after each test.
   - Avoid mocking the behavior the test is intended to prove.
   - Completion: every mock controls an identified external boundary.

5. Configure Vitest 4 correctly.
   - Import standalone configuration helpers from `vitest/config`.
   - Use `test.projects` for multiple configurations; avoid deprecated workspace files.
   - Select `node`, `jsdom`, `happy-dom`, or Browser Mode by runtime behavior.
   - Keep reporters and coverage in the root config when projects share one run.
   - Extend default include or exclude arrays instead of replacing them accidentally.
   - Completion: discovery, environment, and project inheritance match intent.

6. Diagnose and verify.
   - Run the narrowest failing file or test name before the complete suite.
   - Use `--reporter=verbose`, timeouts, or heap diagnostics only for diagnosis.
   - Check for leaked handles, fake timers, stale mocks, and unhandled promises.
   - Run type checking separately when runtime tests do not compile all declarations.
   - Completion: the focused test and its owning suite pass without leaked state.

## Official references

- [Vitest 4 guide](https://v4.vitest.dev/guide/)
- [Configuration](https://v4.vitest.dev/config/)
- [Test projects](https://v4.vitest.dev/guide/projects)
- [Mocking](https://v4.vitest.dev/guide/mocking)
- [Test context and fixtures](https://v4.vitest.dev/guide/test-context)
