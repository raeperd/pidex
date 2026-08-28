<script lang="ts">
  import { safeAgentMessageHref, type AgentMessageNode } from "./AgentMessageParser";
  import AgentMessageBody from "./AgentMessageBody.svelte";
  import AgentMessageCodeBlock, { type HighlightTheme } from "./AgentMessageCodeBlock.svelte";

  let {
    nodes,
    streaming = false,
    theme,
    unwrapParagraphs = false,
  }: {
    nodes: AgentMessageNode[];
    streaming?: boolean;
    theme: HighlightTheme;
    unwrapParagraphs?: boolean;
  } = $props();
</script>

{#each nodes as node (node.key)}
  {#if node.type === "text"}
    {node.text}
  {:else if node.type === "paragraph"}
    {#if unwrapParagraphs}
      <AgentMessageBody nodes={node.children} {streaming} {theme} />
    {:else}
      <p><AgentMessageBody nodes={node.children} {streaming} {theme} /></p>
    {/if}
  {:else if node.type === "heading"}
    <svelte:element this={`h${Math.min(6, Math.max(1, node.depth))}`}>
      <AgentMessageBody nodes={node.children} {streaming} {theme} />
    </svelte:element>
  {:else if node.type === "strong"}
    <strong><AgentMessageBody nodes={node.children} {streaming} {theme} /></strong>
  {:else if node.type === "emphasis"}
    <em><AgentMessageBody nodes={node.children} {streaming} {theme} /></em>
  {:else if node.type === "delete"}
    <del><AgentMessageBody nodes={node.children} {streaming} {theme} /></del>
  {:else if node.type === "codespan"}
    <code>{node.text}</code>
  {:else if node.type === "code"}
    <AgentMessageCodeBlock
      code={node.code}
      language={node.language}
      title={node.title}
      {streaming}
      {theme}
    />
  {:else if node.type === "blockquote"}
    <blockquote><AgentMessageBody nodes={node.children} {streaming} {theme} /></blockquote>
  {:else if node.type === "rule"}
    <hr />
  {:else if node.type === "break"}
    <br />
  {:else if node.type === "html"}
    <svelte:element this={node.block ? "p" : "span"} class="markdown-raw-html"
      >{node.text}</svelte:element
    >
  {:else if node.type === "image"}
    <span class="image-blocked">[remote image disabled: {node.alt}]</span>
  {:else if node.type === "link"}
    {@const href = safeAgentMessageHref(node.href)}
    {#if href}
      <a {href} title={node.title} target="_blank" rel="noopener noreferrer">
        <AgentMessageBody nodes={node.children} {streaming} {theme} />
      </a>
    {:else}
      <AgentMessageBody nodes={node.children} {streaming} {theme} />
    {/if}
  {:else if node.type === "list"}
    <svelte:element
      this={node.ordered ? "ol" : "ul"}
      start={node.ordered && node.start !== 1 ? node.start : undefined}
    >
      {#each node.items as item (item.key)}
        <li class={item.checked !== undefined ? "task-list-item" : undefined}>
          {#if item.checked !== undefined}
            <input
              type="checkbox"
              checked={item.checked}
              disabled
              aria-label={item.checked ? "Completed task" : "Incomplete task"}
            />
          {/if}
          <AgentMessageBody
            nodes={item.children}
            {streaming}
            {theme}
            unwrapParagraphs={!item.loose}
          />
        </li>
      {/each}
    </svelte:element>
  {:else if node.type === "table"}
    <div class="markdown-table" role="region" aria-label="Scrollable table">
      <table>
        <thead>
          <tr>
            {#each node.header as cell (cell.key)}
              <th
                class:text-center!={cell.align === "center"}
                class:text-right!={cell.align === "right"}
              >
                <AgentMessageBody nodes={cell.children} {streaming} {theme} />
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each node.rows as row, rowIndex (`${node.key}:${rowIndex}`)}
            <tr>
              {#each row as cell (cell.key)}
                <td
                  class:text-center!={cell.align === "center"}
                  class:text-right!={cell.align === "right"}
                >
                  <AgentMessageBody nodes={cell.children} {streaming} {theme} />
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/each}
