# Documentation guide

This directory separates the current product target from implementation notes and historical
material.

## Current documents

- [Product requirements](prd.md) — the v1 product target. Remote access, pairing, and packaged
  release work are still planned.
- [Architecture](architecture.md) — the current runtime topology, package boundaries, storage
  responsibilities, and dependency direction.
- [Technical decisions](technical-reference.md) — the selected stack and the reasons behind the
  main boundaries.
- [POC checklist](poc-checklist.md) — the local proof-of-concept scope and its acceptance checks.
- [Architecture improvements](improvements/README.md) — active refactor plans that are still useful
  for future implementation work.

## Status rules

The POC is implemented far enough for the local verification suite, but it is not the complete v1
product. In particular, managed Tailscale setup, pairing, device credentials, revocation, and
packaged release acceptance remain outside the current implementation.

Documents in [archive](archive/) are historical inputs or future-only research. They are retained
for context and should not be treated as current requirements.
