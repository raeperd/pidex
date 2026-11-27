# GitHub review threads

Require authenticated GitHub CLI access; the parent workflow owns the draft and final readiness gates.

1. Fetch review comments with `gh api --paginate repos/<owner>/<repo>/pulls/<number>/comments`. Classify all findings; fix accepted ones, reject with evidence, and retain escalations. Verify fixes and final-head CI before concluding.
2. Reply to each concluded finding using `POST repos/<owner>/<repo>/pulls/<number>/comments/<comment-id>/replies`. Use structured JSON or a body file; include the decision and supporting evidence or fix commit and verification.
3. Query GraphQL `repository.pullRequest.reviewThreads` with pagination, including `id`, `isResolved`, and comment `databaseId`. Match each REST comment to its thread. Resolve concluded threads with the mutation below and require `isResolved: true`; escalations remain unresolved.
   ```graphql
   mutation($threadId: ID!) {
     resolveReviewThread(input: {threadId: $threadId}) {
       thread { id isResolved }
     }
   }
   ```
