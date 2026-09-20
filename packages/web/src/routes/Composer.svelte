<script lang="ts">
  let {
    draft = $bindable(),
    modelName,
    status,
    connected,
    canSend,
    onsend,
    onstop,
  }: {
    draft: string;
    modelName: string;
    status: "idle" | "running" | "stopping";
    connected: boolean;
    canSend: boolean;
    onsend: () => void;
    onstop: () => void;
  } = $props();
  const busy = $derived(status !== "idle");
  let editor: HTMLTextAreaElement | undefined;
</script>

<form
  aria-label="Message composer"
  onsubmit={(event) => {
    event.preventDefault();
    onsend();
    editor?.focus();
  }}
>
  <label class="sr-only" for="prompt">Prompt</label>
  <textarea
    id="prompt"
    bind:this={editor}
    bind:value={draft}
    placeholder="Ask Pi to work on your project…"></textarea>
  <div class="toolbar">
    <div class="metadata">
      <span class="model">{modelName}</span>
      <span class="status" role="status" data-active={connected && busy}>
        <span class="dot" aria-hidden="true"></span>
        {!connected
          ? "Disconnected"
          : status === "idle"
            ? "Idle"
            : status === "stopping"
              ? "Stopping"
              : "Running"}
      </span>
    </div>
    <!-- t3code ComposerPrimaryActions.tsx at 4a560b4e4ebb37efb7f57805ba79e37f5500bdca.
         SVGs licensed under MIT; notice distributed in /licenses/t3code.txt. -->
    <button
      class="send"
      type="submit"
      aria-label="Send"
      title="Send"
      hidden={busy}
      disabled={!canSend}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path
          d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <button
      class="stop"
      type="button"
      aria-label="Stop"
      title={status === "stopping" ? "Stopping…" : "Stop"}
      hidden={!busy}
      disabled={!connected || status === "stopping"}
      onclick={onstop}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <rect x="2" y="2" width="8" height="8" rx="1.5" />
      </svg>
    </button>
  </div>
</form>

<style>
  form {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 24px;
    padding: 20px 20px 16px;
    box-shadow:
      inset 0 1px 0 #ffffff04,
      0 8px 24px #00000014;
  }
  form:has(textarea:focus-visible) {
    outline: 2px solid var(--focus);
    outline-offset: 3px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  textarea {
    display: block;
    width: 100%;
    min-height: 104px;
    max-height: min(30dvh, 240px);
    field-sizing: content;
    overflow: auto;
    resize: none;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--text);
    caret-color: var(--focus);
    font: inherit;
    font-size: 16px;
  }
  textarea:focus-visible {
    outline: none;
  }
  textarea::placeholder {
    color: var(--muted);
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 16px;
  }
  .metadata {
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    color: var(--muted);
    font-size: 12px;
  }
  .model {
    overflow-wrap: anywhere;
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-left: 1px solid var(--border);
    padding-left: 12px;
    white-space: nowrap;
  }
  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
  }
  .status[data-active="true"] .dot {
    color: var(--focus);
  }
  button {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    margin-left: auto;
    padding: 0;
    border: 0;
    border-radius: 50%;
    color: #fff;
    cursor: pointer;
    box-shadow:
      inset 0 1px 1px #ffffff30,
      0 2px 4px #00000030;
  }
  button[hidden] {
    display: none;
  }
  .send {
    background: var(--blue);
  }
  .stop {
    background: #e63844;
  }
  button:hover:enabled {
    filter: brightness(1.12);
  }
  button:active:enabled {
    transform: translateY(1px);
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  @media (max-width: 520px) {
    form {
      padding: 16px;
    }
    button {
      width: 36px;
      height: 36px;
    }
  }
  @media (pointer: coarse) {
    button {
      width: 44px;
      height: 44px;
    }
  }
</style>
