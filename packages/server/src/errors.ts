import { Effect, Schema } from "effect";

export class ConfigurationError extends Schema.TaggedErrorClass<ConfigurationError>()(
  "ConfigurationError",
  { message: Schema.String },
) {}

export class HttpError extends Schema.TaggedErrorClass<HttpError>()("HttpError", {
  status: Schema.Number,
  code: Schema.String,
  message: Schema.String,
}) {}

/**
 * HTTP status for every error code that crosses the oRPC boundary. oRPC 2 dropped `status` from
 * `ORPCError`, so the handler resolves the wire status from `errorStatusMap` keyed by code; this
 * table is both that map's source and the status carried by `HttpError` outside oRPC routes.
 *
 * Codes handled before the oRPC handler runs (`bad_host`, `bad_origin`, `cross_site`, `not_found`,
 * `web_build_missing`) stay out: `bad_host` alone means 400 when the Host header is missing or
 * malformed and 403 when the host is not allowed, so status is not a function of code there.
 */
export const apiErrorStatus = {
  action_conflict: 409,
  stale_revision: 409,
  session_busy: 409,
  run_mismatch: 409,
  interrupted_run: 409,
  dialog_mismatch: 409,
  dialog_value_invalid: 400,
  model_unavailable: 400,
  validation: 400,
  worktree_has_tasks: 409,
  workspace_not_managed_worktree: 400,
  workspace_forbidden: 403,
  workspace_missing: 404,
  workspace_not_directory: 400,
  project_outside_repository: 400,
  project_missing_from_worktree: 400,
  project_not_git: 400,
  worktree_create_failed: 400,
  worktree_branch_read_failed: 400,
  worktree_remove_failed: 400,
  worktree_branch_remove_failed: 400,
} as const;

export type ApiErrorCode = keyof typeof apiErrorStatus;

export function apiError(code: ApiErrorCode, message: string) {
  return HttpError.make({ status: apiErrorStatus[code], code, message });
}

const actionProtocolCodes = Schema.Literals([
  "action_conflict",
  "stale_revision",
  "session_busy",
  "run_mismatch",
  "interrupted_run",
]);

export class ActionProtocolError extends Schema.TaggedErrorClass<ActionProtocolError>()(
  "ActionProtocolError",
  {
    code: actionProtocolCodes,
    message: Schema.String,
  },
) {}

class ServerOperationError extends Schema.TaggedErrorClass<ServerOperationError>()(
  "ServerOperationError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

type ApplicationError = ActionProtocolError | ConfigurationError | HttpError | ServerOperationError;

export function applicationError(operation: string, cause: unknown): ApplicationError {
  if (
    cause instanceof ActionProtocolError ||
    cause instanceof ConfigurationError ||
    cause instanceof HttpError ||
    cause instanceof ServerOperationError
  )
    return cause;
  return ServerOperationError.make({ operation, message: failureMessage(operation, cause), cause });
}

export function failureMessage(operation: string, cause: unknown): string {
  return cause instanceof Error ? cause.message : `Unexpected failure during ${operation}`;
}

export interface TaggedOperationError<Tag extends string> {
  readonly _tag: Tag;
  readonly operation: string;
  readonly message: string;
  readonly cause: unknown;
}

/** Wraps throwing calls into `{ _tag, operation, message, cause }` failures. */
export function taggedAttempt<Tag extends string>(tag: Tag) {
  const fail = (operation: string, cause: unknown): TaggedOperationError<Tag> => ({
    _tag: tag,
    operation,
    message: failureMessage(operation, cause),
    cause,
  });
  return {
    promise: <A>(operation: string, evaluate: () => Promise<A>) =>
      Effect.tryPromise({ try: evaluate, catch: (cause) => fail(operation, cause) }),
    sync: <A>(operation: string, evaluate: () => A) =>
      Effect.try({ try: evaluate, catch: (cause) => fail(operation, cause) }),
  };
}
