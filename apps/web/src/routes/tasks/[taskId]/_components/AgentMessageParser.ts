import { decodeHTMLStrict } from "entities";
import { Marked, type MarkedToken, type Token, type Tokens } from "marked";

export type AgentMessageAlignment = "center" | "left" | "right" | null;

interface AgentMessageNodeBase {
  key: string;
}

interface AgentMessageContainerNode extends AgentMessageNodeBase {
  children: AgentMessageNode[];
}

export type AgentMessageNode =
  | (AgentMessageContainerNode & { type: "blockquote" })
  | (AgentMessageContainerNode & { type: "delete" })
  | (AgentMessageContainerNode & { type: "emphasis" })
  | (AgentMessageContainerNode & { type: "paragraph" })
  | (AgentMessageContainerNode & { type: "strong" })
  | (AgentMessageContainerNode & { type: "heading"; depth: number })
  | (AgentMessageContainerNode & { type: "link"; href: string; title?: string })
  | {
      type: "list";
      key: string;
      ordered: boolean;
      start: number;
      items: AgentMessageListItem[];
    }
  | {
      type: "table";
      key: string;
      header: AgentMessageTableCell[];
      rows: AgentMessageTableCell[][];
    }
  | { type: "code"; key: string; code: string; language: string; title?: string }
  | { type: "codespan"; key: string; text: string }
  | { type: "html"; key: string; text: string; block: boolean }
  | { type: "image"; key: string; alt: string }
  | { type: "text"; key: string; text: string }
  | { type: "break"; key: string }
  | { type: "rule"; key: string };

export interface AgentMessageListItem {
  key: string;
  children: AgentMessageNode[];
  checked?: boolean;
  loose: boolean;
}

export interface AgentMessageTableCell {
  key: string;
  align: AgentMessageAlignment;
  children: AgentMessageNode[];
}

const marked = new Marked({ gfm: true, breaks: false });

export function parseAgentMessage(value: string): AgentMessageNode[] {
  return parseTokens(marked.lexer(value), "root");
}

export function safeAgentMessageHref(value: string, baseHref = browserHref()): string | null {
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
  const title = titleMatch?.[1] ?? titleMatch?.[2] ?? titleMatch?.[3] ?? inferredFileName(metadata);
  return { language: language.toLowerCase(), ...(title ? { title } : {}) };
}

function parseTokens(tokens: Token[], parentKey: string): AgentMessageNode[] {
  return tokens.flatMap((token, index) =>
    parseToken(token as MarkedToken, `${parentKey}.${index}`),
  );
}

function parseToken(token: MarkedToken, position: string): AgentMessageNode[] {
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

function parseList(token: Tokens.List, key: string): AgentMessageNode {
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

function parseTable(token: Tokens.Table, key: string): AgentMessageNode {
  return {
    type: "table",
    key,
    header: token.header.map((cell, index) => parseTableCell(cell, `${key}.head.${index}`)),
    rows: token.rows.map((row, rowIndex) =>
      row.map((cell, columnIndex) => parseTableCell(cell, `${key}.${rowIndex}.${columnIndex}`)),
    ),
  };
}

function parseTableCell(cell: Tokens.TableCell, position: string): AgentMessageTableCell {
  return {
    key: `${position}:cell`,
    align: cell.align,
    children: parseTokens(cell.tokens, position),
  };
}

function parseUnknownToken(token: Token, key: string): AgentMessageNode[] {
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
