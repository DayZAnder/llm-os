// Durable file writes for the user's data.
//
// A plain writeFileSync is not enough on a real machine: Linux keeps new file
// contents in memory for up to ~30 s, so a VM that is powered off hard (or a
// power cut) comes back with the file created but empty. And writing in place
// can leave half a file behind. Every write of user state goes through here:
// write a temp file, fsync it, rename it over the old one, fsync the folder.

import { openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export function writeFileAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  let fd = null;
  try {
    fd = openSync(tmp, 'w');
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== null) { try { closeSync(fd); } catch {} }
    rmSync(tmp, { force: true });
    throw err;
  }
  // Make the rename itself survive a crash (directories can't be fsynced on Windows)
  if (process.platform !== 'win32') {
    try {
      const dfd = openSync(dirname(path), 'r');
      try { fsyncSync(dfd); } finally { closeSync(dfd); }
    } catch {}
  }
}
