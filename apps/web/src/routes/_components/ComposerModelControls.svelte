<script lang="ts">
  import type { ChatSnapshot, Workspace } from "@pidex/api";
  import Icon from "./Icon.svelte";

  const composerSelectLabelClass =
    "flex h-7.5 min-w-0 flex-none items-center gap-1.5 overflow-hidden rounded-lg pl-2 text-muted transition-colors duration-[140ms] hover:bg-secondary hover:text-foreground focus-within:bg-secondary focus-within:text-foreground max-[560px]:h-9 max-[560px]:gap-1 max-[560px]:pl-1.5";
  const composerSelectClass =
    "h-full max-w-44 min-w-0 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap border-0 border-none bg-transparent pr-5 text-control font-semibold text-inherit outline-none disabled:cursor-not-allowed disabled:opacity-42 max-[560px]:pr-3.5 max-[560px]:text-control [@supports(appearance:base-select)]:flex [@supports(appearance:base-select)]:items-center [@supports(appearance:base-select)]:gap-1.5 [@supports(appearance:base-select)]:pr-1.5 [@supports(appearance:base-select)]:[appearance:base-select] [@supports(appearance:base-select)]:[&::picker(select)]:[appearance:base-select] [@supports(appearance:base-select)]:[&::picker(select)]:max-h-[min(22rem,calc(100dvh-2rem))] [@supports(appearance:base-select)]:[&::picker(select)]:overflow-y-auto [@supports(appearance:base-select)]:[&::picker(select)]:[position-area:block-start_span-inline-end] [@supports(appearance:base-select)]:[&::picker(select)]:[position-try-fallbacks:flip-block] [@supports(appearance:base-select)]:[&::picker(select)]:mb-2 [@supports(appearance:base-select)]:[&::picker(select)]:rounded-xl [@supports(appearance:base-select)]:[&::picker(select)]:border [@supports(appearance:base-select)]:[&::picker(select)]:border-border-strong [@supports(appearance:base-select)]:[&::picker(select)]:bg-card [@supports(appearance:base-select)]:[&::picker(select)]:p-1 [@supports(appearance:base-select)]:[&::picker(select)]:text-foreground [@supports(appearance:base-select)]:[&::picker(select)]:shadow-[0_18px_48px_rgb(0_0_0/24%)] [@supports(appearance:base-select)]:[&::picker(select)]:[scrollbar-width:thin] [@supports(appearance:base-select)]:[&::picker-icon]:size-3 [@supports(appearance:base-select)]:[&::picker-icon]:ml-0.5 [@supports(appearance:base-select)]:[&::picker-icon]:text-faint [@supports(appearance:base-select)]:[&::picker-icon]:transition-[rotate] [@supports(appearance:base-select)]:[&::picker-icon]:duration-[140ms] [@supports(appearance:base-select)]:[&::picker-icon]:ease-[ease] [@supports(appearance:base-select)]:[&:open::picker-icon]:rotate-180 [@supports(appearance:base-select)]:[&_option]:flex [@supports(appearance:base-select)]:[&_option]:min-h-8 [@supports(appearance:base-select)]:[&_option]:items-center [@supports(appearance:base-select)]:[&_option]:rounded-lg [@supports(appearance:base-select)]:[&_option]:px-2 [@supports(appearance:base-select)]:[&_option]:py-[0.45rem] [@supports(appearance:base-select)]:[&_option]:text-xs [@supports(appearance:base-select)]:[&_option]:font-medium [@supports(appearance:base-select)]:[&_option]:text-muted [@supports(appearance:base-select)]:[&_option]:cursor-pointer [@supports(appearance:base-select)]:[&_option:hover]:bg-secondary [@supports(appearance:base-select)]:[&_option:hover]:text-foreground [@supports(appearance:base-select)]:[&_option:focus-visible]:bg-secondary [@supports(appearance:base-select)]:[&_option:focus-visible]:text-foreground [@supports(appearance:base-select)]:[&_option:checked]:bg-[color-mix(in_srgb,var(--primary)_12%,var(--secondary))] [@supports(appearance:base-select)]:[&_option:checked]:font-[650] [@supports(appearance:base-select)]:[&_option:checked]:text-foreground [@supports(appearance:base-select)]:[&_option::checkmark]:order-1 [@supports(appearance:base-select)]:[&_option::checkmark]:ml-auto [@supports(appearance:base-select)]:[&_option::checkmark]:text-primary";

  let {
    models,
    selectedModel,
    thinkingLevel,
    modelDisabled,
    thinkingDisabled,
    onModel,
    onThinking,
  }: {
    models: Workspace["models"];
    selectedModel: string;
    thinkingLevel: ChatSnapshot["thinkingLevel"];
    modelDisabled: boolean;
    thinkingDisabled: boolean;
    onModel: (model: string) => void;
    onThinking: (level: ChatSnapshot["thinkingLevel"]) => void;
  } = $props();
</script>

<label class={composerSelectLabelClass}>
  <select
    class={[
      composerSelectClass,
      "max-[560px]:w-36 max-[560px]:max-w-36 [@supports(appearance:base-select)]:[&::picker(select)]:min-w-56",
    ]}
    aria-label="Model"
    value={selectedModel}
    onchange={(event) => onModel(event.currentTarget.value)}
    disabled={modelDisabled}
  >
    {#each models as model (model.id)}<option value={model.id}>{model.name}</option>{/each}
  </select>
</label>
<span class="mx-0.5 h-4 w-px flex-none bg-border max-[560px]:mx-0" aria-hidden="true"></span>
<label class={composerSelectLabelClass}>
  <span
    class="grid w-4 flex-none place-items-center text-current max-[560px]:hidden"
    aria-hidden="true"><Icon name="activity" size={14} /></span
  >
  <select
    class={[
      composerSelectClass,
      "max-[560px]:max-w-27 [@supports(appearance:base-select)]:[&::picker(select)]:min-w-36",
    ]}
    aria-label="Thinking level"
    value={thinkingLevel}
    onchange={(event) => onThinking(event.currentTarget.value as ChatSnapshot["thinkingLevel"])}
    disabled={thinkingDisabled}
  >
    <option value="off">Off</option><option value="minimal">Minimal</option><option value="low"
      >Low</option
    ><option value="medium">Medium</option><option value="high">High</option><option value="xhigh"
      >Extra high</option
    ><option value="max">Max</option>
  </select>
</label>
