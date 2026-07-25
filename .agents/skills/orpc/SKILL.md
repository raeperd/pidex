---
name: orpc
description: Build type-safe APIs with oRPC; load when defining contracts, implementing procedures, creating RPC handlers or clients, composing middleware, handling errors, or testing oRPC transports.
---

Use installed oRPC packages as the type-safe boundary from contract to transport.

## Process

1. Identify the oRPC architecture.
   - Read installed package versions and their exported type declarations.
   - Identify contract-first, procedure-first, or router-conversion architecture.
   - Identify the server adapter, protocol, client link, and schema library.
   - Completion: package versions and the end-to-end request path are known.

2. Define the public contract.
   - Use `@orpc/contract` for contracts that must be shared without server internals.
   - Define input, output, errors, route metadata, and procedure groups explicitly.
   - Keep transport-neutral validation and public types in the contract layer.
   - Export client types from the contract and keep server types private.
   - Completion: callers can derive a typed client without importing server-only code.

3. Implement procedures and context.
   - Implement contracts with the installed `@orpc/server` contract API.
   - Build context at the transport boundary and refine it through middleware.
   - Use middleware for shared authorization, tracing, and invariant checks.
   - Throw `ORPCError` instances for intentional API failures.
   - Keep procedure handlers focused on validated input and typed output.
   - Completion: context, middleware, errors, and outputs conform to the contract.

4. Configure the handler.
   - Import `RPCHandler` from the adapter matching the runtime, such as `node` or `fetch`.
   - Set the route prefix and request context once at the HTTP boundary.
   - Preserve the handler's not-matched behavior so other routes can continue.
   - Add body limits, validation, CORS, or CSRF plugins where the threat model needs them.
   - Use the matching WebSocket adapter when streaming requires upgrades.
   - Completion: HTTP status, routing, context, plugins, and upgrades are deterministic.

5. Configure the client.
   - Create the link that matches the server protocol and runtime transport.
   - Derive the client from the exported contract type with `createORPCClient`.
   - Add response validation when runtime verification of server output is required.
   - Pass abort signals, headers, and client context through supported link options.
   - Handle declared errors with oRPC's type-safe error helpers.
   - Completion: client calls preserve contract types and transport cancellation.

6. Verify the API boundary.
   - Test procedures directly only for isolated domain behavior.
   - Add integration coverage through the real handler and client for transport behavior.
   - Cover valid input, validation, declared errors, auth context, and cancellation.
   - Assert protocol payload details only when compatibility requires them.
   - Completion: tests prove both contract behavior and transport integration.

## Official references

- [Contract-first development](https://orpc.dev/docs/contract-first/define-contract)
- [Implement contracts](https://orpc.dev/docs/contract-first/implement-contract)
- [RPC handler](https://orpc.dev/docs/rpc-handler)
- [Client-side clients](https://orpc.dev/docs/client/client-side)
- [Error handling](https://orpc.dev/docs/error-handling)
- [Testing and mocking](https://orpc.dev/docs/advanced/testing-mocking)
