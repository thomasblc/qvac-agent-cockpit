// Skills pane backend (read-only v1): walk skill dirs, parse SKILL.md frontmatter, join usage.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";

const ROOT = join(homedir(), ".hermes/skills");
export function listSkills() {
  if (!existsSync(ROOT)) return [];
  let usage = {};
  try { usage = JSON.parse(readFileSync(join(ROOT, ".usage.json"), "utf8")); } catch { /* */ }
  const out = [];
  for (const cat of readdirSync(ROOT, { withFileTypes: true })) {
    if (!cat.isDirectory() || cat.name.startsWith(".")) continue;
    for (const sk of readdirSync(join(ROOT, cat.name), { withFileTypes: true })) {
      if (!sk.isDirectory()) continue;
      const md = join(ROOT, cat.name, sk.name, "SKILL.md");
      if (!existsSync(md)) continue;
      let fm = {};
      try {
        const src = readFileSync(md, "utf8");
        const m = src.match(/^---\n([\s\S]*?)\n---/);
        if (m) fm = yaml.load(m[1]) || {};
      } catch { /* frontmatter optional */ }
      const u = usage[sk.name] || usage[`${cat.name}/${sk.name}`] || {};
      out.push({
        name: fm.name || sk.name, category: cat.name,
        description: String(fm.description || "").slice(0, 140),
        version: fm.version || null,
        useCount: u.use_count || 0, lastUsedAt: u.last_used_at || null, pinned: !!u.pinned,
      });
    }
  }
  out.sort((a, b) => b.useCount - a.useCount);
  return out;
}
