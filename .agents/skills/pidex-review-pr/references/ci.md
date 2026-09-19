# CI verification

Require authenticated GitHub CLI access and capture the target PR head before checking.

- Check every reported check for that head with `gh pr checks <number> --json bucket,name,state,link`. Wait while pending; only `pass` or `skipping` is green. If no checks are reported, verify whether CI is expected and report missing required CI as a blocker.
- Inspect failures with `gh run list --commit <sha>` and `gh run view <run-id> --log-failed`, or the external check's link. Fix PR-caused failures, run relevant local checks, commit/push intended fixes, and repeat for the new head. Report unrelated or uncertain failures as blockers.
- Require the current head still to equal the checked head before recording green. Record each new checked head as a CI iteration.
