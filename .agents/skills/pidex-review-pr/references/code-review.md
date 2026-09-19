# Independent review

Require subagent support; report an actual tooling blocker when it is unavailable.

The review coordinator launches separate Standards and Spec subagents. Give each the immutable diff `git diff <base>...<head>`, commit list `git log <base>..<head> --oneline`, and layer scope. Confirm revisions exist and the diff is nonempty. Resolve the spec from the linked issue and its accepted spec; ask only if the intended requirements cannot be established.

- **Standards:** provide repository instructions and relevant conventions. Require file/line evidence for violations, skipping tooling-enforced rules. Consider naming, duplication, misplaced responsibility, data clumps, primitive obsession, repeated dispatch, scattered changes, mixed responsibilities, speculative abstractions, long navigation chains, pointless delegation, and unused inheritance only as judgment calls; repository rules take precedence.
- **Spec:** provide the issue/spec and accepted decisions. Report missing or partial requirements, unintended scope, and incorrect behavior with requirement quotes and file/line evidence. Judge only the selected layer's promised behavior.
- Keep reports separate under Standards and Spec, with counts for each. Findings need an actionable consequence; do not turn preferences into blockers. The parent agent classifies and fixes findings and requests follow-up review only for changed portions.
