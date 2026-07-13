// P0 spike 04: kanban copy-to-tmp read + 9-DB FTS timing.
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, readdirSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
const H = homedir();
// kanban: copy db (+wal if present) to tmp, open the copy
let s = Date.now();
const kb = join(H, ".hermes/kanban.db"), tmp = join(tmpdir(), "ck-kanban.db");
copyFileSync(kb, tmp); if (existsSync(kb + "-wal")) copyFileSync(kb + "-wal", tmp + "-wal");
const kdb = new DatabaseSync(tmp);
const evCount = kdb.prepare("SELECT COUNT(*) c, MAX(id) mx FROM task_events").get();
const tasks = kdb.prepare("SELECT COUNT(*) c FROM tasks").get();
kdb.close();
console.log(`kanban copy+read: ${Date.now() - s}ms | task_events: ${evCount.c} (max id ${evCount.mx}) | tasks: ${tasks.c}`);
// 9-DB FTS
s = Date.now();
const dbs = [join(H, ".hermes/state.db")];
const profDir = join(H, ".hermes/profiles");
if (existsSync(profDir)) for (const p of readdirSync(profDir)) { const f = join(profDir, p, "state.db"); if (existsSync(f)) dbs.push(f); }
let hits = 0, opened = 0;
for (const f of dbs) {
  try {
    const db = new DatabaseSync("file:" + f + "?mode=ro", { readOnly: true });
    opened++;
    try { hits += db.prepare("SELECT COUNT(*) c FROM messages_fts WHERE messages_fts MATCH 'coffee'").get().c; } catch { /* no fts table */ }
    db.close();
  } catch { /* locked/absent */ }
}
console.log(`FTS across ${opened}/${dbs.length} DBs: ${Date.now() - s}ms | 'coffee' hits: ${hits}`);
console.log("SPIKE04 PASS");
