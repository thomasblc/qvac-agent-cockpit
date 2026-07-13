// Pure content transform for inserting a link under a "## Related" section.
// Ported verbatim from the Obsidian plugin's review-hardened links.ts (3 corruption P0s fixed):
//  - a "## Related" inside a fenced code block is never hijacked
//  - a "## Related" at start-of-file is found (no duplicate section)
//  - "## Relatedness..." prefixes are not matched; CRLF headings tolerated
export function insertRelatedSection(content, link) {
  if (content.includes(link)) return content; // exact link already present
  const lines = content.split("\n");
  let inFence = false, headingLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (!inFence && /^## Related[ \t]*$/.test(line)) { headingLine = i; break; }
  }
  if (headingLine >= 0) { lines.splice(headingLine + 1, 0, `- ${link}`); return lines.join("\n"); }
  return content + (content.endsWith("\n") ? "" : "\n") + `\n## Related\n- ${link}\n`;
}
