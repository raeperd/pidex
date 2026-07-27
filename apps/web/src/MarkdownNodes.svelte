<script lang="ts">
  import type { HighlightTheme } from "./highlight.js";
  import { safeMarkdownHref, type MarkdownNode } from "./markdown.js";
  import MarkdownCode from "./MarkdownCode.svelte";
  import MarkdownNodes from "./MarkdownNodes.svelte";

  let {
    nodes,
    streaming = false,
    theme,
    unwrapParagraphs = false,
  }: {
    nodes: MarkdownNode[];
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
      <MarkdownNodes nodes={node.children} {streaming} {theme} />
    {:else}
      <p><MarkdownNodes nodes={node.children} {streaming} {theme} /></p>
    {/if}
  {:else if node.type === "heading"}
    <svelte:element this={`h${Math.min(6, Math.max(1, node.depth))}`}>
      <MarkdownNodes nodes={node.children} {streaming} {theme} />
    </svelte:element>
  {:else if node.type === "strong"}
    <strong><MarkdownNodes nodes={node.children} {streaming} {theme} /></strong>
  {:else if node.type === "emphasis"}
    <em><MarkdownNodes nodes={node.children} {streaming} {theme} /></em>
  {:else if node.type === "delete"}
    <del><MarkdownNodes nodes={node.children} {streaming} {theme} /></del>
  {:else if node.type === "codespan"}
    <code>{node.text}</code>
  {:else if node.type === "code"}
    <MarkdownCode
      code={node.code}
      language={node.language}
      title={node.title}
      {streaming}
      {theme}
    />
  {:else if node.type === "blockquote"}
    <blockquote><MarkdownNodes nodes={node.children} {streaming} {theme} /></blockquote>
  {:else if node.type === "rule"}
    <hr />
  {:else if node.type === "break"}
    <br />
  {:else if node.type === "html"}
    {#if node.block}<p class="markdown-raw-html">{node.text}</p>{:else}{node.text}{/if}
  {:else if node.type === "image"}
    <span class="image-blocked">[remote image disabled: {node.alt}]</span>
  {:else if node.type === "link"}
    {@const href = safeMarkdownHref(node.href)}
    {#if href}
      <a {href} title={node.title} target="_blank" rel="noopener noreferrer">
        <MarkdownNodes nodes={node.children} {streaming} {theme} />
      </a>
    {:else}
      <MarkdownNodes nodes={node.children} {streaming} {theme} />
    {/if}
  {:else if node.type === "list"}
    {#if node.ordered}
      <ol start={node.start === 1 ? undefined : node.start}>
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
            <MarkdownNodes
              nodes={item.children}
              {streaming}
              {theme}
              unwrapParagraphs={!item.loose}
            />
          </li>
        {/each}
      </ol>
    {:else}
      <ul>
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
            <MarkdownNodes
              nodes={item.children}
              {streaming}
              {theme}
              unwrapParagraphs={!item.loose}
            />
          </li>
        {/each}
      </ul>
    {/if}
  {:else if node.type === "table"}
    <div class="markdown-table" role="region" aria-label="Scrollable table">
      <table>
        <thead>
          <tr>
            {#each node.header as cell (cell.key)}
              <th style:text-align={cell.align ?? undefined}>
                <MarkdownNodes nodes={cell.children} {streaming} {theme} />
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each node.rows as row, rowIndex (`${node.key}:${rowIndex}`)}
            <tr>
              {#each row as cell (cell.key)}
                <td style:text-align={cell.align ?? undefined}>
                  <MarkdownNodes nodes={cell.children} {streaming} {theme} />
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/each}
