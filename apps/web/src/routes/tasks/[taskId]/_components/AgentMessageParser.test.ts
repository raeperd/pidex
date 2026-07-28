import { describe, expect, it } from "vitest";
import {
  parseCodeInfo,
  parseAgentMessage,
  safeAgentMessageHref,
  type AgentMessageNode,
} from "./AgentMessageParser";

describe("parseAgentMessage", () => {
  it("builds component nodes for GFM content", () => {
    const nodes = parseAgentMessage(`# Result

- [x] shipped
- [ ] pending

| Name | State |
| --- | --- |
| renderer | **ready** |`);

    expect(nodes.map((node) => node.type)).toEqual(["heading", "list", "table"]);
    const list = nodes[1];
    expect(list?.type).toBe("list");
    if (list?.type !== "list") throw new Error("Expected a list");
    expect(list.items.map((item) => item.checked)).toEqual([true, false]);
    // The rendered checkbox replaces marked's "[x] " marker token.
    expect(flattenText(list.items[0]?.children ?? [])).toBe("shipped");
  });

  it("keeps raw HTML as text-only nodes", () => {
    const nodes = parseAgentMessage('<script>alert("nope")</script>');

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      type: "html",
      text: '<script>alert("nope")</script>',
    });
  });

  it("removes image destinations from the render tree", () => {
    const [paragraph] = parseAgentMessage("![private diagram](https://tracker.example/pixel.png)");
    expect(paragraph?.type).toBe("paragraph");
    const image = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;

    expect(image).toMatchObject({ type: "image", alt: "private diagram" });
    expect(image).not.toHaveProperty("href");
  });

  it("keeps block keys stable while a later block streams", () => {
    const before = parseAgentMessage("Stable paragraph.\n\nStreaming");
    const after = parseAgentMessage("Stable paragraph.\n\nStreaming response");

    // The growing tail keeps its key so Svelte patches it instead of remounting,
    // which would discard the code block's wrap and copy state mid-stream.
    expect(before.map((node) => node.key)).toEqual(after.map((node) => node.key));
  });

  it("represents incomplete fences as code", () => {
    const [node] = parseAgentMessage("```ts\nconst value = 1;");

    expect(node).toMatchObject({ type: "code", language: "ts", code: "const value = 1;" });
  });

  it("decodes entities in text while preserving code spans", () => {
    const [paragraph] = parseAgentMessage("AT&amp;T &copy; &#169; &copy `&amp; &copy;`");
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("Expected a paragraph");

    expect(paragraph.children).toEqual([
      expect.objectContaining({ type: "text", text: "AT&T © © &copy " }),
      expect.objectContaining({ type: "codespan", text: "&amp; &copy;" }),
    ]);
  });

  it("never stores raw markup in ordinary text nodes", () => {
    const nodes = parseAgentMessage("Text <img src=x onerror=alert(1)> after");
    const text = flattenText(nodes);

    expect(text).toContain("<img src=x onerror=alert(1)>");
    expect(nodes.some((node) => node.type === "image")).toBe(false);
  });
});

describe("safeAgentMessageHref", () => {
  it.each([
    ["https://example.com/docs", "https://example.com/docs"],
    ["mailto:hello@example.com", "mailto:hello@example.com"],
    ["../guide", "https://pidex.example/guide"],
  ])("allows supported destination %s", (href, expected) => {
    expect(safeAgentMessageHref(href, "https://pidex.example/tasks/1")).toBe(expected);
  });

  it.each(["javascript:alert(1)", "data:text/html,unsafe", "file:///etc/passwd"])(
    "rejects unsafe destination %s",
    (href) => {
      expect(safeAgentMessageHref(href, "https://pidex.example/tasks/1")).toBeNull();
    },
  );
});

describe("parseCodeInfo", () => {
  it("extracts a language and filename", () => {
    expect(parseCodeInfo('tsx title="src/AgentMessage.svelte"')).toEqual({
      language: "tsx",
      title: "src/AgentMessage.svelte",
    });
  });

  it("falls back to plain text", () => {
    expect(parseCodeInfo(undefined)).toEqual({ language: "text" });
  });
});

function flattenText(nodes: AgentMessageNode[]): string {
  return nodes
    .map((node) => {
      if ("children" in node) return flattenText(node.children);
      if (node.type === "text" || node.type === "html" || node.type === "codespan")
        return node.text;
      return "";
    })
    .join("");
}
