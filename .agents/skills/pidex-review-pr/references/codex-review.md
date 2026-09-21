# Codex review

Require authenticated GitHub CLI access; the parent workflow owns the draft and final readiness gates.

1. After green CI, record `reviewed_sha`. Inspect the local run record and PR activity before posting so resuming cannot duplicate a trigger.
   ```sh
   gh api --method POST repos/<owner>/<repo>/issues/<number>/comments -f body='@codex review'
   ```
   Record the returned comment ID, creation time, URL, and reviewed SHA immediately. Send exactly one trigger per PR in this workflow, even after fixes or rebases.
2. Poll the trigger's reactions and PR reviews:
   ```sh
   gh api repos/<owner>/<repo>/issues/comments/<trigger-id>/reactions
   gh api --paginate repos/<owner>/<repo>/pulls/<number>/reviews
   ```
   Accept a `+1` reaction from `chatgpt-codex-connector*` as no findings, or a review from that bot matching `reviewed_sha` and submitted after the trigger. `eyes` is acknowledgment only. Include findings in the review body as well as its inline comments.
3. Fetch findings with `gh api repos/<owner>/<repo>/pulls/<number>/reviews/<review-id>/comments`. Classify all findings; fix accepted ones, reject with evidence, and retain escalations. Verify fixes and final-head CI before concluding.
4. Reply to each concluded finding using `POST repos/<owner>/<repo>/pulls/<number>/comments/<comment-id>/replies`. Use structured JSON or a body file; include the decision and supporting evidence or fix commit and verification.
5. Query GraphQL `repository.pullRequest.reviewThreads` with pagination, including `id`, `isResolved`, and comment `databaseId`. Match each REST comment to its thread. Resolve concluded threads with the mutation below and require `isResolved: true`; escalations remain unresolved.
   ```graphql
   mutation($threadId: ID!) {
     resolveReviewThread(input: {threadId: $threadId}) {
       thread { id isResolved }
     }
   }
   ```
