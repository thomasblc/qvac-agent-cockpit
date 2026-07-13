// Gamification as instrumentation (deep plan L9): counters + records fed by OUTCOMES
// (missions completed, files reviewed, links created, verified tools), never raw activity.
// Backed by cockpit.db (files.js owns it). Achievements are profiler-toned; egress is a
// separate honest lane (substrate PIDs only).
import { bump, counters } from "./files.js";

const ACHIEVEMENTS = [
  { id: "first_contact", test: (c) => (c.missions || 0) >= 1, name: "First contact", desc: "one mission completed" },
  { id: "toolsmith", test: (c) => (c.tool_calls || 0) >= 50, name: "Toolsmith", desc: "50 tool calls run locally" },
  { id: "librarian", test: (c) => (c.links_created || 0) >= 5, name: "Librarian", desc: "5 links woven into the brain" },
  { id: "reviewer", test: (c) => (c.files_reviewed || 0) >= 10, name: "Reviewer", desc: "10 files reviewed" },
  { id: "century", test: (c) => (c.tool_calls || 0) >= 100, name: "Century", desc: "100 tool calls run locally" },
  { id: "night_shift", test: (c) => !!c._night, name: "Night shift", desc: "a mission finished between 1am and 5am", secret: true },
];

export function recordMission({ toolCount = 0, at = Date.now() } = {}) {
  bump("missions");
  if (toolCount) bump("tool_calls", toolCount);
  const hr = new Date(at).getHours();
  if (hr >= 1 && hr < 5) bump("_night");
}
export function snapshot() {
  const c = counters();
  return {
    counters: {
      missions: c.missions || 0, tool_calls: c.tool_calls || 0,
      links_created: c.links_created || 0, files_reviewed: c.files_reviewed || 0, files_written: c.files_written || 0,
    },
    achievements: ACHIEVEMENTS.map((a) => ({ id: a.id, name: a.name, desc: a.desc, secret: !!a.secret, unlocked: a.test(c) })),
  };
}
