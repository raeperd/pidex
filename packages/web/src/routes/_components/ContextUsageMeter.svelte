<script lang="ts">
  import type { ContextUsage } from "@pidex/api";
  import { onDestroy } from "svelte";

  const RADIUS = 9.75;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  let { usage }: { usage: ContextUsage } = $props();
  const componentId = $props.id();
  const detailsId = `${componentId}-details`;

  let pinned = $state(false);
  let hovered = $state(false);
  let focused = $state(false);
  let dismissed = $state(false);
  let horizontalShift = $state(0);
  let triggerElement: HTMLButtonElement | undefined;
  let observedToolbar: HTMLElement | undefined;
  let toolbarMutationObserver: MutationObserver | undefined;
  let toolbarResizeObserver: ResizeObserver | undefined;
  let repositionFrame: number | undefined;
  let expanded = $derived(pinned || (!dismissed && (hovered || focused)));
  let normalizedPercent = $derived(Math.max(0, Math.min(100, usage.percent ?? 0)));
  let percentageLabel = $derived(formatPercentage(usage.percent));
  let dashOffset = $derived(CIRCUMFERENCE * (1 - normalizedPercent / 100));
  let overloaded = $derived(normalizedPercent > 90);
  let ariaLabel = $derived(
    percentageLabel
      ? `Context window ${percentageLabel} used`
      : "Context window usage is being calculated",
  );

  function toggleDetails(event: MouseEvent) {
    positionDetails(event.currentTarget);
    pinned = !pinned;
    dismissed = !pinned;
  }

  function showOnHover(event: PointerEvent) {
    if (event.pointerType !== "touch") revealDetails(event.currentTarget, "hover");
  }

  function showOnFocus(event: FocusEvent) {
    revealDetails(event.currentTarget, "focus");
  }

  function revealDetails(target: EventTarget | null, via: "hover" | "focus") {
    positionDetails(target);
    if (via === "hover") hovered = true;
    else focused = true;
    dismissed = false;
  }

  function closeDetails() {
    pinned = false;
    dismissed = true;
  }

  function handleDocumentPointerDown(event: PointerEvent) {
    if (!expanded || isInsideMeter(event.target)) return;
    closeDetails();
  }

  function handleDocumentKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !expanded) return;
    event.preventDefault();
    event.stopPropagation();
    closeDetails();
  }

  function handleWindowResize() {
    if (triggerElement) positionDetails(triggerElement);
  }

  function positionDetails(target: EventTarget | null) {
    if (!(target instanceof HTMLButtonElement)) return;
    triggerElement = target;
    observeToolbar(target.parentElement?.parentElement);
    const details = target.parentElement?.querySelector<HTMLElement>(".context-meter__popover");
    if (!details) return;

    const anchorRight = target.getBoundingClientRect().right;
    const baseLeft = anchorRight - details.offsetWidth;
    const baseRight = anchorRight;
    const viewportInset = 16;
    if (baseLeft < viewportInset) horizontalShift = viewportInset - baseLeft;
    else if (baseRight > innerWidth - viewportInset)
      horizontalShift = innerWidth - viewportInset - baseRight;
    else horizontalShift = 0;
  }

  function observeToolbar(toolbar: HTMLElement | null | undefined) {
    if (!toolbar || toolbar === observedToolbar) return;
    disconnectToolbarObservers();
    observedToolbar = toolbar;
    toolbarMutationObserver = new MutationObserver(repositionExpandedDetails);
    toolbarMutationObserver.observe(toolbar, { childList: true });
    toolbarResizeObserver = new ResizeObserver(repositionExpandedDetails);
    toolbarResizeObserver.observe(toolbar);
  }

  function repositionExpandedDetails() {
    if (repositionFrame !== undefined) cancelAnimationFrame(repositionFrame);
    repositionFrame = requestAnimationFrame(() => {
      repositionFrame = undefined;
      if (expanded && triggerElement) positionDetails(triggerElement);
    });
  }

  function disconnectToolbarObservers() {
    if (repositionFrame !== undefined) cancelAnimationFrame(repositionFrame);
    toolbarMutationObserver?.disconnect();
    toolbarResizeObserver?.disconnect();
    repositionFrame = undefined;
    toolbarMutationObserver = undefined;
    toolbarResizeObserver = undefined;
    observedToolbar = undefined;
  }

  function isInsideMeter(target: EventTarget | null) {
    if (!(target instanceof Element)) return false;
    return (
      target.closest("[data-context-meter]")?.getAttribute("data-context-meter") === componentId
    );
  }

  function formatPercentage(value: number | null) {
    if (value === null || !Number.isFinite(value)) return null;
    return value < 10 ? `${value.toFixed(1).replace(/\.0$/, "")}%` : `${Math.round(value)}%`;
  }

  function formatTokens(value: number | null) {
    if (value === null || !Number.isFinite(value)) return "Calculating";
    if (value < 1_000) return `${Math.round(value)}`;
    if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
    if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  }

  onDestroy(disconnectToolbarObservers);
</script>

<svelte:window onresize={handleWindowResize} />
<svelte:document onpointerdown={handleDocumentPointerDown} onkeydown={handleDocumentKeydown} />

<div class="relative inline-flex flex-none" data-context-meter={componentId}>
  <button
    class="context-meter__trigger inline-grid size-8 place-items-center rounded-[999px] border-0 border-none bg-transparent text-primary transition-[background-color] duration-[140ms] ease-[ease] hover:bg-secondary focus-visible:bg-secondary"
    type="button"
    aria-label={ariaLabel}
    aria-describedby={detailsId}
    aria-controls={detailsId}
    aria-expanded={expanded}
    onclick={toggleDetails}
    onfocus={showOnFocus}
    onblur={() => (focused = false)}
    onpointerenter={showOnHover}
    onpointerleave={() => (hovered = false)}
  >
    <svg class="size-4.5 [rotate:-90deg]" viewBox="0 0 24 24" aria-hidden="true">
      <circle
        class="fill-none [stroke-width:3] [stroke:color-mix(in_srgb,var(--faint)_26%,transparent)]"
        cx="12"
        cy="12"
        r={RADIUS}
      />
      <circle
        class={[
          "context-meter__progress fill-none [stroke-linecap:round] [stroke-width:3] transition-[stroke-dashoffset] duration-500 ease-[ease-out]",
          overloaded ? "context-meter__progress--danger stroke-danger" : "stroke-current",
        ]}
        cx="12"
        cy="12"
        r={RADIUS}
        stroke-dasharray={CIRCUMFERENCE}
        stroke-dashoffset={dashOffset}
      />
    </svg>
  </button>

  <div
    class={[
      "context-meter__popover absolute right-0 bottom-[calc(100%+0.625rem)] z-20 grid box-border w-[min(16rem,calc(100vw-2rem))] gap-2.5 rounded-xl border border-border bg-[color-mix(in_srgb,var(--card)_96%,transparent)] p-3 text-control text-muted shadow-popover transition-[opacity,translate] duration-[120ms] ease-[ease] motion-reduce:transition-none",
      expanded
        ? "pointer-events-auto opacity-100 [translate:var(--context-popover-shift,0)_0] delay-150"
        : "pointer-events-none opacity-0 [translate:var(--context-popover-shift,0)_0.25rem] delay-0",
    ]}
    id={detailsId}
    role="tooltip"
    aria-hidden={!expanded}
    data-open={expanded}
    style:--context-popover-shift={`${horizontalShift}px`}
  >
    <div class="flex items-center justify-between gap-3">
      <strong class="font-semibold text-muted">Context Window</strong>
      <span class="font-mono text-meta whitespace-nowrap tabular-nums"
        >{percentageLabel ? `${percentageLabel} · ` : ""}{formatTokens(usage.tokens)}/{formatTokens(
          usage.contextWindow,
        )}</span
      >
    </div>
    <div
      class="h-1.5 overflow-hidden rounded-[999px] bg-[color-mix(in_srgb,var(--faint)_18%,transparent)]"
      role="progressbar"
      aria-label="Context window usage"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={usage.percent === null ? undefined : Math.round(normalizedPercent)}
    >
      <span
        class={[
          "context-meter__bar-fill block h-full rounded-[inherit] transition-[width] duration-500 ease-[ease-out]",
          overloaded ? "context-meter__bar-fill--danger bg-danger" : "bg-primary",
        ]}
        style:width={`${normalizedPercent}%`}
      ></span>
    </div>
    <div class="flex items-center justify-between gap-3">
      <span class="text-faint">Total processed</span><strong
        class="font-mono text-meta font-semibold whitespace-nowrap text-muted tabular-nums"
        >{formatTokens(usage.totalProcessedTokens)}</strong
      >
    </div>
    {#if usage.compactsAutomatically}
      <p class="mt-0.5 mb-0 text-faint">Pi automatically compacts its context when needed.</p>
    {/if}
  </div>
</div>
