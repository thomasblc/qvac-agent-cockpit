// Centralized path jail for every FS write/read the cockpit does to user files. Closes the
// TOCTOU + symlink + hardlink escape paths an external audit flagged: a compromised agent could
// race a *.md path into a symlink between list and write, or plant a hardlink to a file outside
// the corpus. Rules: the resolved real path must be UNDER a corpus root (via path.relative, not
// startsWith, so `workspace-evil` can't pass as `workspace`), and the entry itself must be a plain
// regular file with link count 1 (no symlink, no hardlink).
import { realpathSync, lstatSync, openSync, fstatSync, readSync, writeSync, closeSync, constants } from "node:fs";
import { relative, isAbsolute } from "node:path";

export function underRoot(realAbs, roots) {
  for (const r of roots) {
    let rr; try { rr = realpathSync(r); } catch { continue; }
    const rel = relative(rr, realAbs);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return true;
  }
  return false;
}

// Assert an existing file is a safe, in-jail, plain regular file (no symlink, no hardlink).
export function assertSafeFile(abs, roots) {
  const st = lstatSync(abs); // lstat: do NOT follow a final symlink
  if (st.isSymbolicLink()) throw new Error("refusing a symlink");
  if (!st.isFile()) throw new Error("not a regular file");
  if (st.nlink > 1) throw new Error("refusing a hardlinked file");
  const real = realpathSync(abs);
  if (!underRoot(real, roots)) throw new Error("path escapes the corpus jail");
  return real;
}

// Open-then-fstat write: O_NOFOLLOW so a symlink swapped in after the check fails at open; fstat
// the fd to re-confirm regular + nlink==1 on the actual opened inode (closes the TOCTOU window).
export function safeWriteFile(abs, content, roots) {
  assertSafeFile(abs, roots); // pre-check (fast reject)
  const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(abs, constants.O_WRONLY | constants.O_TRUNC | NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink > 1) throw new Error("file changed under us (symlink/hardlink)");
    writeSync(fd, Buffer.from(String(content)));
  } finally { closeSync(fd); }
}
