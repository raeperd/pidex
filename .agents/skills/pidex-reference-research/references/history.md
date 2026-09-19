# History on demand

Use only when the research question requires older code or how behavior changed. Shallow `log` and `blame` results are incomplete; a shallow boundary is not evidence that a line originated there.

1. Record the inspected commit as `PINNED_SHA` and identify the missing evidence.
   - For a known commit/tag, fetch only that snapshot: `git -C <path> fetch --depth 1 --no-tags origin <ref-or-sha>`. Record `git -C <path> rev-parse FETCH_HEAD` before another fetch overwrites it.
   - For ancestry searches, deepen from the pinned commit in small batches: `git -C <path> fetch --deepen=20 --no-tags origin <pinned-sha>`. Inspect the relevant file's history after each batch and repeat only if the question remains unresolved.
   - Avoid blanket `--all`, `--tags`, or `--unshallow` fetches. Report remaining uncertainty if the investigation cannot establish the answer.

2. Inspect without moving the research checkout.
   - Use `git show <sha>:<path>`, path-limited `git log`, or `git diff <sha-a> <sha-b> -- <path>`; resolve abbreviated refs to full SHAs for evidence links.
   - Keep `HEAD` at `PINNED_SHA`. History fetches may update `FETCH_HEAD` or remote refs, but must not replace the original research snapshot.
   - Record why history was fetched and which commits support the finding. Stop fetching when the question is answered and let the parent workflow clean up the temporary root.
