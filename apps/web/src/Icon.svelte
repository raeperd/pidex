<script lang="ts">
  export let name:
    | "activity"
    | "check"
    | "chevron"
    | "compact"
    | "compose"
    | "folder"
    | "menu"
    | "rename"
    | "search"
    | "send"
    | "shield"
    | "stop"
    | "tool"
    | "x";
  export let size = 16;
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === "activity"}
    <path d="M3 12h4l2.5-7 5 14 2.5-7h4" />
  {:else if name === "check"}
    <path d="m5 12 4 4L19 6" />
  {:else if name === "chevron"}
    <path d="m9 18 6-6-6-6" />
  {:else if name === "compact"}
    <path d="m8 3 4 4 4-4M8 21l4-4 4 4M4 12h16" />
  {:else if name === "compose"}
    <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
  {:else if name === "folder"}
    <path d="M3 6.5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  {:else if name === "menu"}
    <path d="M4 7h16M4 12h16M4 17h16" />
  {:else if name === "rename"}
    <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
  {:else if name === "search"}
    <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
  {:else if name === "send"}
    <path d="M12 19V5M6 11l6-6 6 6" />
  {:else if name === "shield"}
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" />
  {:else if name === "stop"}
    <rect x="7" y="7" width="10" height="10" rx="2" />
  {:else if name === "tool"}
    <path d="M14.7 6.3a4 4 0 0 0-5-5L7 4l3 3 2.7-2.7a4 4 0 0 0 2 2Z" /><path d="m9 7-6.5 6.5a2.1 2.1 0 0 0 3 3L12 10" /><path d="m14 14 6 6" />
  {:else if name === "x"}
    <path d="M18 6 6 18M6 6l12 12" />
  {/if}
</svg>
