import { describe, expect, it } from "vitest";
import { parseCodeInfo, parseMarkdown, safeMarkdownHref, type MarkdownNode } from "./markdown";

describe("parseMarkdown", () => {
  it("builds component nodes for GFM content", () => {
    const nodes = parseMarkdown(`# Result

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
  });

  it("keeps raw HTML as text-only nodes", () => {
    const nodes = parseMarkdown('<script>alert("nope")</script>');

    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      type: "html",
      text: '<script>alert("nope")</script>',
    });
  });

  it("removes image destinations from the render tree", () => {
    const [paragraph] = parseMarkdown("![private diagram](https://tracker.example/pixel.png)");
    expect(paragraph?.type).toBe("paragraph");
    const image = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;

    expect(image).toMatchObject({ type: "image", alt: "private diagram" });
    expect(image).not.toHaveProperty("href");
  });

  it("keeps completed block keys stable while a later block streams", () => {
    const before = parseMarkdown("Stable paragraph.\n\nStreaming");
    const after = parseMarkdown("Stable paragraph.\n\nStreaming response");

    expect(before[0]?.key).toBe(after[0]?.key);
    expect(before[1]?.key).not.toBe(after[1]?.key);
  });

  it("represents incomplete fences as code", () => {
    const [node] = parseMarkdown("```ts\nconst value = 1;");

    expect(node).toMatchObject({ type: "code", language: "ts", code: "const value = 1;" });
  });

  it("never stores raw markup in ordinary text nodes", () => {
    const nodes = parseMarkdown("Text <img src=x onerror=alert(1)> after");
    const text = flattenText(nodes);

    expect(text).toContain("<img src=x onerror=alert(1)>");
    expect(nodes.some((node) => node.type === "image")).toBe(false);
  });
});

describe("safeMarkdownHref", () => {
  it.each([
    ["https://example.com/docs", "https://example.com/docs"],
    ["mailto:hello@example.com", "mailto:hello@example.com"],
    ["../guide", "https://pidex.example/guide"],
  ])("allows supported destination %s", (href, expected) => {
    expect(safeMarkdownHref(href, "https://pidex.example/tasks/1")).toBe(expected);
  });

  it.each(["javascript:alert(1)", "data:text/html,unsafe", "file:///etc/passwd"])(
    "rejects unsafe destination %s",
    (href) => {
      expect(safeMarkdownHref(href, "https://pidex.example/tasks/1")).toBeNull();
    },
  );
});

describe("parseCodeInfo", () => {
  it("extracts a language and filename", () => {
    expect(parseCodeInfo('tsx title="src/App.svelte"')).toEqual({
      language: "tsx",
      title: "src/App.svelte",
    });
  });

  it("falls back to plain text", () => {
    expect(parseCodeInfo(undefined)).toEqual({ language: "text" });
  });
});

function flattenText(nodes: MarkdownNode[]): string {
  return nodes
    .map((node) => {
      if ("children" in node) return flattenText(node.children);
      if (node.type === "text" || node.type === "html" || node.type === "codespan")
        return node.text;
      return "";
    })
    .join("");
}
