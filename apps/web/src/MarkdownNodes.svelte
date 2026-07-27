<script lang="ts" module>
  import { decodeHTMLStrict } from "entities";
  import { Marked, type MarkedToken, type Token, type Tokens } from "marked";

  export type MarkdownAlignment = "center" | "left" | "right" | null;

  interface MarkdownNodeBase {
    key: string;
  }

  interface MarkdownContainerNode extends MarkdownNodeBase {
    children: MarkdownNode[];
  }

  export type MarkdownNode =
    | (MarkdownContainerNode & { type: "blockquote" })
    | (MarkdownContainerNode & { type: "delete" })
    | (MarkdownContainerNode & { type: "emphasis" })
    | (MarkdownContainerNode & { type: "paragraph" })
    | (MarkdownContainerNode & { type: "strong" })
    | (MarkdownContainerNode & { type: "heading"; depth: number })
    | (MarkdownContainerNode & { type: "link"; href: string; title?: string })
    | {
        type: "list";
        key: string;
        ordered: boolean;
        start: number;
        items: MarkdownListItem[];
      }
    | {
        type: "table";
        key: string;
        header: MarkdownTableCell[];
        rows: MarkdownTableCell[][];
      }
    | { type: "code"; key: string; code: string; language: string; title?: string }
    | { type: "codespan"; key: string; text: string }
    | { type: "html"; key: string; text: string; block: boolean }
    | { type: "image"; key: string; alt: string }
    | { type: "text"; key: string; text: string }
    | { type: "break"; key: string }
    | { type: "rule"; key: string };

  export interface MarkdownListItem {
    key: string;
    children: MarkdownNode[];
    checked?: boolean;
    loose: boolean;
  }

  export interface MarkdownTableCell {
    key: string;
    align: MarkdownAlignment;
    children: MarkdownNode[];
  }

  const marked = new Marked({ gfm: true, breaks: false });

  export function parseMarkdown(value: string): MarkdownNode[] {
    return parseTokens(marked.lexer(value), "root");
  }

  export function safeMarkdownHref(value: string, baseHref = browserHref()): string | null {
    try {
      const url = baseHref ? new URL(value, baseHref) : new URL(value);
      return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  export function parseCodeInfo(info: string | undefined): {
    language: string;
    title?: string;
  } {
    const normalized = info?.trim() ?? "";
    if (!normalized) return { language: "text" };

    const [language = "text", ...metadata] = normalized.split(/\s+/);
    const titleMatch = normalized.match(
      /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i,
    );
    const title =
      titleMatch?.[1] ?? titleMatch?.[2] ?? titleMatch?.[3] ?? inferredFileName(metadata);
    return { language: language.toLowerCase(), ...(title ? { title } : {}) };
  }

  function parseTokens(tokens: Token[], parentKey: string): MarkdownNode[] {
    return tokens.flatMap((token, index) =>
      parseToken(token as MarkedToken, `${parentKey}.${index}`),
    );
  }

  function parseToken(token: MarkedToken, position: string): MarkdownNode[] {
    const key = `${position}:${token.type}`;
    switch (token.type) {
      case "space":
      case "def":
        return [];
      // The list item renders its own checkbox from `checked`; drop marked's marker token.
      case "checkbox":
        return [];
      case "blockquote":
        return [{ type: "blockquote", key, children: parseTokens(token.tokens, key) }];
      case "code": {
        const info = parseCodeInfo(token.lang);
        return [{ type: "code", key, code: token.text, ...info }];
      }
      case "heading":
        return [
          { type: "heading", key, depth: token.depth, children: parseTokens(token.tokens, key) },
        ];
      case "hr":
        return [{ type: "rule", key }];
      case "html":
        return [{ type: "html", key, text: token.text, block: token.block }];
      case "list":
        return [parseList(token, key)];
      case "paragraph":
        return [{ type: "paragraph", key, children: parseTokens(token.tokens, key) }];
      case "table":
        return [parseTable(token, key)];
      case "br":
        return [{ type: "break", key }];
      case "codespan":
        return [{ type: "codespan", key, text: token.text }];
      case "del":
        return [{ type: "delete", key, children: parseTokens(token.tokens, key) }];
      case "em":
        return [{ type: "emphasis", key, children: parseTokens(token.tokens, key) }];
      case "escape":
        return [{ type: "text", key, text: token.text }];
      case "image":
        return [{ type: "image", key, alt: token.text }];
      case "link":
        return [
          {
            type: "link",
            key,
            href: token.href,
            ...(token.title ? { title: token.title } : {}),
            children: parseTokens(token.tokens, key),
          },
        ];
      case "strong":
        return [{ type: "strong", key, children: parseTokens(token.tokens, key) }];
      case "text":
        return token.tokens?.length
          ? parseTokens(token.tokens, key)
          : [{ type: "text", key, text: decodeHTMLStrict(token.text) }];
      default:
        return parseUnknownToken(token, key);
    }
  }

  function parseList(token: Tokens.List, key: string): MarkdownNode {
    return {
      type: "list",
      key,
      ordered: token.ordered,
      start: typeof token.start === "number" ? token.start : 1,
      items: token.items.map((item, index) => ({
        key: `${key}.${index}:${item.type}`,
        children: parseTokens(item.tokens, `${key}.${index}`),
        ...(item.task ? { checked: item.checked ?? false } : {}),
        loose: item.loose,
      })),
    };
  }

  function parseTable(token: Tokens.Table, key: string): MarkdownNode {
    return {
      type: "table",
      key,
      header: token.header.map((cell, index) => parseTableCell(cell, `${key}.head.${index}`)),
      rows: token.rows.map((row, rowIndex) =>
        row.map((cell, columnIndex) => parseTableCell(cell, `${key}.${rowIndex}.${columnIndex}`)),
      ),
    };
  }

  function parseTableCell(cell: Tokens.TableCell, position: string): MarkdownTableCell {
    return {
      key: `${position}:cell`,
      align: cell.align,
      children: parseTokens(cell.tokens, position),
    };
  }

  function parseUnknownToken(token: Token, key: string): MarkdownNode[] {
    if ("tokens" in token && token.tokens?.length) return parseTokens(token.tokens, key);
    const text = "text" in token && typeof token.text === "string" ? token.text : token.raw;
    return text ? [{ type: "text", key, text }] : [];
  }

  function inferredFileName(metadata: string[]): string | undefined {
    return metadata.find((candidate) => /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/.test(candidate));
  }

  function browserHref(): string | undefined {
    return typeof window === "undefined" ? undefined : window.location.href;
  }
</script>

<script lang="ts">
  import MarkdownCode, { type HighlightTheme } from "./MarkdownCode.svelte";
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
    <svelte:element this={node.block ? "p" : "span"} class="markdown-raw-html"
      >{node.text}</svelte:element
    >
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
          <MarkdownNodes nodes={item.children} {streaming} {theme} unwrapParagraphs={!item.loose} />
        </li>
      {/each}
    </svelte:element>
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
