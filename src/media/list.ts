import type { MediaListItem } from "./queue.js";

export function mediaLink(item: MediaListItem): string {
  if (!item.title) return item.url;
  // Bound the complete 21-item embed below Discord's 4096-character limit,
  // including escaping. Titles are untrusted Markdown, never raw link syntax.
  const plain = item.title.replace(/\s+/g, " ").trim();
  const label = plain.length > 60 ? plain.slice(0, 59) + "…" : plain;
  const escaped = label.replace(/[\\`*_{}\[\]()<>~|]/g, "\\$&");
  return `[${escaped}](<${item.url}>)`;
}
