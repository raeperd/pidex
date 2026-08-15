export type FaviconStatus = "none" | "running" | "attention";

export function faviconHref(status: FaviconStatus): string {
  if (status === "running") return "/favicon-running.svg";
  if (status === "attention") return "/favicon-attention.svg";
  return "/favicon.svg";
}
