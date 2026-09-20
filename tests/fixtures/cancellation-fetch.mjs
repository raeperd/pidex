// Hold the provider's aborted response until the fixture acknowledges cancellation.
// Pi, tools, application handlers, and RPC all run unchanged.
const providerUrl = process.env.PIDEX_TEST_PROVIDER_URL;
if (process.env.ELECTRON_RUN_AS_NODE === "1" && providerUrl) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (!String(input).startsWith(`${providerUrl}/v1/`) || !response.body) return response;
    const reader = response.body.getReader();
    return new Response(
      new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) controller.close();
            else controller.enqueue(value);
          } catch (error) {
            if (init?.signal?.aborted) await originalFetch(`${providerUrl}/cancel`);
            controller.error(error);
          }
        },
        cancel: () => reader.cancel(),
      }),
      { status: response.status, headers: response.headers },
    );
  };
}
