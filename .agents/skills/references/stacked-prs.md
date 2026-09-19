# Stacked PRs

Read before creating dependent PR layers or modifying an existing stack. Independent work belongs on separate branches or stacks.

1. Prepare the CLI.
   - Require authenticated `gh`; install the extension with `gh extension install github/gh-stack` if missing. Use `gh stack <command> --help` for installed command flags and report unavailable tooling before dependent operations.
   - Inspect `git remote -v` and select the intended remote. Pass `--remote <name>` to remote operations; with multiple remotes, configure `remote.pushDefault` for commands without that flag.
   - Use non-interactive commands: `gh stack view --json`, `gh stack submit --auto`, and explicit branch names for `init`, `add`, and `checkout`.
   - Completion: authenticated tooling and the intended remote are available.

2. Establish layer ownership.
   - Inspect existing stacks with `gh stack view --json`. Create or adopt branches in dependency order with `gh stack init <first> [<next>...] --base <trunk>`; use `gh stack add <branch>` for a new layer above the current one.
   - Create the stack before implementing multiple layers. Each PR targets its immediate parent, and its diff/review scope includes only its own changes.
   - Before editing, identify the owning layer from stack state and file history, then run `gh stack checkout <branch>`. Preserve unrelated work.
   - Completion: the current branch owns the intended change and has the correct parent.

3. Propagate and verify changes.
   - Commit on the owning layer, then run `gh stack rebase --upstack --remote <name>` to update dependents. Use `--no-trunk` when intentionally updating only inter-branch dependencies. Resolve conflicts, stage resolutions, and run `gh stack rebase --continue`; use `--abort` to restore the stack if necessary.
   - Publish with `gh stack submit --auto --remote <name>`; new PRs are drafts. Apply the repository commit/title convention to generated titles with `gh pr edit`. Use `gh stack sync --remote <name>` to reconcile remote changes; verify the resulting state even when the command exits successfully.
   - After prerequisite changes, rerun affected layers' checks. Return changed ready PRs to draft and resume their review-pr checks before restoring readiness. Preserve review records so rebases cannot duplicate a Codex trigger within the run.
   - Verify remote bases and diffs with `gh pr view` and `gh stack view --json`. Merge only on explicit request; `gh stack merge <target> --yes --squash` includes unmerged ancestors, so verify that full scope is authorized.
   - Completion: remote bases/diffs are correct and affected PRs are verified or explicitly awaiting review/CI.
