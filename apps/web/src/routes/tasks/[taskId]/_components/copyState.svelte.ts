import { onDestroy } from "svelte";

/** Clipboard "copied" feedback shared by the response and code-block copy buttons. */
export function createCopyState() {
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(copiedTimer));
  return {
    get copied() {
      return copied;
    },
    async copy(text: string) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => (copied = false), 1_500);
      } catch {
        copied = false;
      }
    },
  };
}
