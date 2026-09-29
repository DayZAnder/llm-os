// Where LLM OS keeps things.
//
// Everything the user owns — apps they generated, files, app storage, theme,
// desktop layout, custom shells, usage — lives under DATA_DIR. The OS itself
// (src/, examples/) is replaced on upgrade; DATA_DIR never is.
//
// Default: <project>/data. The VM images set LLMOS_DATA_DIR to a separate
// data disk so a new OS image can be swapped in without touching user data.

import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

export const PROJECT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

export const DATA_DIR = process.env.LLMOS_DATA_DIR
  ? resolve(process.env.LLMOS_DATA_DIR)
  : join(PROJECT_ROOT, 'data');

export function dataPath(...parts) {
  return join(DATA_DIR, ...parts);
}
