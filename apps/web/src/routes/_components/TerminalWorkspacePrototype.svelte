<script lang="ts">
  import "@xterm/xterm/css/xterm.css";
  import { FitAddon } from "@xterm/addon-fit";
  import { Terminal } from "@xterm/xterm";
  import {
    safeParse,
    terminalPrototypeServerMessageSchema,
    type TerminalPrototypeClientMessage,
  } from "@pidex/api";
  import type { Attachment } from "svelte/attachments";
  import Icon from "./Icon.svelte";

  type TerminalStatus = "connecting" | "live" | "exited" | "error" | "disconnected";

  let {
    chatId,
    onclose,
    workspaceName,
  }: {
    chatId: string;
    onclose: () => void;
    workspaceName: string;
  } = $props();

  let status = $state<TerminalStatus>("connecting");
  let detail = $state("Opening shell…");
  let generation = $state(0);
  let height = $state(300);
  let resizing = false;
  let resizeStart = 0;
  let sizeStart = 0;

  function restart() {
    status = "connecting";
    detail = "Opening shell…";
    generation += 1;
  }

  function beginResize(event: PointerEvent) {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    resizing = true;
    resizeStart = event.clientY;
    sizeStart = height;
    target.setPointerCapture(event.pointerId);
  }

  function resize(event: PointerEvent) {
    if (!resizing) return;
    const nextHeight = sizeStart + resizeStart - event.clientY;
    height = clamp(nextHeight, 180, window.innerHeight - 220);
  }

  function finishResize(event: PointerEvent) {
    const target = event.currentTarget;
    resizing = false;
    if (target instanceof HTMLElement && target.hasPointerCapture(event.pointerId))
      target.releasePointerCapture(event.pointerId);
  }

  function terminalAttachment(version: number): Attachment<HTMLDivElement> {
    return (element) => {
      void version;
      status = "connecting";
      detail = "Opening shell…";
      let disposed = false;
      let helloSent = false;
      let resizeFrame: number | undefined;
      const terminal = new Terminal({
        cursorBlink: true,
        fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
        fontSize: 12,
        lineHeight: 1.3,
        scrollback: 5_000,
        theme: {
          background: "#151515",
          foreground: "#d7d7d7",
          cursor: "#d9d9d9",
          selectionBackground: "#4f5f725f",
        },
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(element);

      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${scheme}://${location.host}/api/prototype/terminal`);
      const send = (message: TerminalPrototypeClientMessage) =>
        socket.send(JSON.stringify(message));
      const input = terminal.onData((data) => {
        if (socket.readyState === WebSocket.OPEN) send({ type: "input", data });
      });

      function fit() {
        if (disposed || !element.clientWidth || !element.clientHeight) return;
        try {
          fitAddon.fit();
          if (helloSent && socket.readyState === WebSocket.OPEN)
            send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
        } catch {
          // The pane can briefly be zero-sized while resizing.
        }
      }

      function scheduleFit() {
        if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(fit);
      }

      const observer = new ResizeObserver(scheduleFit);
      observer.observe(element);
      scheduleFit();
      socket.addEventListener("open", () => {
        fit();
        send({ type: "hello", chatId, cols: terminal.cols, rows: terminal.rows });
        helloSent = true;
      });
      socket.addEventListener("message", (event) => {
        const message = terminalServerMessage(event.data);
        if (!message) return;
        if (message.type === "output") terminal.write(message.data);
        else if (message.type === "ready") {
          status = "live";
          detail = message.cwd;
          terminal.focus();
        } else if (message.type === "exit") {
          status = "exited";
          detail = `Exited with code ${message.code}`;
        } else {
          status = "error";
          detail = message.message;
          terminal.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`);
        }
      });
      socket.addEventListener("error", () => socket.close());
      socket.addEventListener("close", () => {
        if (!disposed && status !== "exited" && status !== "error") {
          status = "disconnected";
          detail = "Terminal connection closed";
        }
      });

      return () => {
        disposed = true;
        if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
        observer.disconnect();
        input.dispose();
        if (socket.readyState === WebSocket.OPEN) send({ type: "kill" });
        socket.close(1000, "Terminal pane closed");
        terminal.dispose();
      };
    };
  }

  function terminalServerMessage(value: unknown) {
    if (typeof value !== "string") return undefined;
    try {
      const result = safeParse(terminalPrototypeServerMessageSchema, JSON.parse(value));
      return result.success ? result.output : undefined;
    } catch {
      return undefined;
    }
  }

  function clamp(value: number, minimum: number, maximum: number) {
    return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
  }
</script>

<section
  class="relative flex min-h-0 min-w-0 w-full flex-none flex-col overflow-hidden border-t border-[#303030] bg-[#151515] text-[#d7d7d7] max-[900px]:!h-[min(38dvh,300px)]"
  style:height={`${height}px`}
  aria-label="Terminal prototype"
  data-terminal-prototype="bottom"
>
  <button
    class="absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize border-0 bg-transparent p-0"
    aria-label="Resize terminal pane"
    onpointerdown={beginResize}
    onpointermove={resize}
    onpointerup={finishResize}
    onpointercancel={finishResize}
  ></button>

  <header class="flex h-9 min-h-9 items-center border-b border-[#2b2b2b] bg-[#1a1a1a] pl-2">
    <div
      class="flex h-full min-w-0 max-w-[min(380px,55%)] items-center gap-2 border-r border-[#303030] px-2.5 text-[11px]"
      title={detail}
    >
      <Icon name="terminal" size={13} />
      <span class="truncate font-medium text-[#e0e0e0]">{workspaceName}</span>
      <span
        class={`size-1.5 flex-none rounded-full ${status === "live" ? "bg-emerald-400" : status === "error" ? "bg-red-400" : "bg-[#666]"}`}
      ></span>
    </div>
    <button
      class="grid size-8 flex-none place-items-center text-base text-[#888] hover:bg-white/6 hover:text-white"
      onclick={restart}
      aria-label="New terminal session"
      title="New terminal session">+</button
    >
    <span class="min-w-0 flex-1 truncate px-2 font-mono text-[9px] text-[#777]">{detail}</span>
    <div class="flex h-full flex-none items-center pr-1">
      <button
        class="grid size-7 place-items-center rounded text-[#888] hover:bg-white/8 hover:text-white"
        onclick={onclose}
        aria-label="Close terminal pane"
        title="Close terminal"><Icon name="x" size={13} /></button
      >
    </div>
  </header>

  {#key `${chatId}:${generation}`}
    <div class="min-h-0 flex-1 px-2 py-1.5" {@attach terminalAttachment(generation)}></div>
  {/key}
</section>

<style>
  section :global(.xterm) {
    height: 100%;
  }

  section :global(.xterm-viewport) {
    scrollbar-color: #555 transparent;
    scrollbar-width: thin;
  }
</style>
