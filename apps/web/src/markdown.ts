import DOMPurify from "dompurify";
import { Marked, Renderer } from "marked";

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const renderer = new Renderer();
renderer.html = ({ text }) => escape(text);
renderer.image = ({ text }) => `<span class="image-blocked">[remote image disabled: ${escape(text)}]</span>`;
renderer.link = ({ href, title, tokens }) => {
  let safe: URL; try { safe = new URL(href, window.location.href); } catch { return escape(href); }
  if (!["http:", "https:", "mailto:"].includes(safe.protocol)) return escape(href);
  const label = renderer.parser.parseInline(tokens); const titleAttr = title ? ` title="${escape(title)}"` : "";
  return `<a href="${escape(safe.href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${label}</a>`;
};
const marked = new Marked({ gfm: true, breaks: false, renderer });
export function safeMarkdown(value: string): string { return DOMPurify.sanitize(marked.parse(value) as string, { FORBID_TAGS: ["img", "style", "iframe", "object", "embed"], ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):)/i }); }
