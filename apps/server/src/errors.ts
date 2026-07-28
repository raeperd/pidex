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
) {
  readonly status = 409;
}

class ServerOperationError extends Schema.TaggedErrorClass<ServerOperationError>()(
  "ServerOperationError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type ApplicationError =
  | ActionProtocolError
  | ConfigurationError
  | HttpError
  | ServerOperationError;

export function attemptOperation<A>(
  operation: string,
  evaluate: () => A | PromiseLike<A>,
): Effect.Effect<A, ApplicationError> {
  return Effect.tryPromise({
    try: () => Promise.resolve().then(evaluate),
    catch: (cause) => applicationError(operation, cause),
  });
}

export function applicationError(operation: string, cause: unknown): ApplicationError {
  if (
    cause instanceof ActionProtocolError ||
    cause instanceof ConfigurationError ||
    cause instanceof HttpError ||
    cause instanceof ServerOperationError
  )
    return cause;
  return ServerOperationError.make({
    operation,
    message: cause instanceof Error ? cause.message : `Unexpected failure during ${operation}`,
    cause,
  });
}
