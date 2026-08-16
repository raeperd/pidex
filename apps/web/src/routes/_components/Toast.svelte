<script lang="ts" module>
  export interface ToastTimer {
    readonly start: () => void;
    readonly pause: () => void;
    readonly resume: () => void;
    readonly cancel: () => void;
  }

  /**
   * Remaining-ms bookkeeping so a pause/resume cycle never restarts the countdown from the full
   * duration. `resume` is just `start` again: both schedule whatever time is left.
   */
  export function createToastTimer(onExpire: () => void, durationMs: number): ToastTimer {
    let remainingMs = durationMs;
    let startedAt: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    function clearScheduled() {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      timeoutId = undefined;
    }

    function start() {
      if (timeoutId !== undefined || remainingMs <= 0) return;
      startedAt = Date.now();
      timeoutId = setTimeout(() => {
        timeoutId = undefined;
        startedAt = undefined;
        remainingMs = 0;
        onExpire();
      }, remainingMs);
    }

    function pause() {
      if (startedAt === undefined) return;
      remainingMs = Math.max(0, remainingMs - (Date.now() - startedAt));
      startedAt = undefined;
      clearScheduled();
    }

    function cancel() {
      clearScheduled();
      startedAt = undefined;
    }

    return { start, pause, resume: start, cancel };
  }

  const DURATION_MS = 6_000;
  const CLAMP_THRESHOLD = 120;
</script>

<script lang="ts">
  import type { Attachment } from "svelte/attachments";
  import Icon from "./Icon.svelte";

  let { message, ondismiss }: { message: string; ondismiss: () => void } = $props();

  // Plain (non-rune) bookkeeping, deliberately: the attachment below reads these to decide
  // whether to arm the timer, and an `{@attach}` reruns (cleanup + re-execute — a fresh
  // showPopover/timer) whenever *any* reactive state it reads changes. If these were `$state`,
  // every hover/tab-visibility flip would destroy and recreate the timer instead of pausing it,
  // resetting the countdown. Mutating them from plain event handlers (not $effect) keeps them
  // outside the attachment's reactive dependency tracking entirely.
  let hovered = false;
  let hidden = false;
  let copied = $state(false);
  let activeTimer: ToastTimer | undefined;

  let clamp = $derived(message.length >= CLAMP_THRESHOLD);

  function attachToast(current: string): Attachment<HTMLDivElement> {
    return (element) => {
      void current;
      element.showPopover();
      const timer = createToastTimer(ondismiss, DURATION_MS);
      activeTimer = timer;
      if (!hovered && !hidden) timer.start();
      return () => {
        timer.cancel();
        if (activeTimer === timer) activeTimer = undefined;
        element.hidePopover();
      };
    };
  }

  function pause() {
    hovered = true;
    activeTimer?.pause();
  }

  function resume() {
    hovered = false;
    if (!hidden) activeTimer?.resume();
  }

  function syncVisibility() {
    hidden = document.hidden;
    if (hidden) activeTimer?.pause();
    else if (!hovered) activeTimer?.resume();
  }

  async function copyMessage() {
    await navigator.clipboard.writeText(message);
    copied = true;
    setTimeout(() => (copied = false), 2_000);
  }
</script>

<svelte:document onvisibilitychange={syncVisibility} />

{#if message}
  <!-- inset-auto/m-0 override the popover UA stylesheet's default `inset: 0; margin: auto;`
       (which centers the box and would otherwise fight bottom-6/left-1/2 below). -->
  <div
    class="fixed inset-auto bottom-6 left-1/2 z-30 m-0 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 rounded-xl border border-danger/30 bg-card p-3 text-control text-foreground shadow-raised transition-[opacity,translate] duration-150 ease-out motion-reduce:transition-none max-[900px]:bottom-24"
    popover="manual"
    role="alert"
    {@attach attachToast(message)}
    onmouseenter={pause}
    onmouseleave={resume}
  >
    <div class="flex items-start gap-2.5">
      <span class="mt-0.5 flex-none text-danger" aria-hidden="true"
        ><Icon name="alert" size={16} /></span
      >
      <p class={`m-0 min-w-0 flex-1 leading-relaxed select-text ${clamp ? "line-clamp-4" : ""}`}>
        {message}
      </p>
      <div class="flex flex-none items-center gap-0.5">
        {#if clamp}
          <button
            class="grid rounded p-1 text-muted hover:text-foreground"
            type="button"
            aria-label="Copy error"
            onclick={copyMessage}
          >
            <Icon name={copied ? "check" : "copy"} size={14} />
          </button>
        {/if}
        <button
          class="grid rounded p-1 text-muted hover:text-foreground"
          type="button"
          aria-label="Dismiss error"
          onclick={ondismiss}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    </div>
  </div>
{/if}
