// bins.mjs — where glyph3d's binaries live. `make` installs glyph3d-cli, g3d-termd and g3d into ONE
// directory, G3D_BIN_DIR (default ~/.local/bin), and every tool runs them from there: there is no
// second copy in the checkout. The relay finds g3d-termd beside itself, so the three stay together.
import os from 'node:os';
import path from 'node:path';

/** The install directory (`G3D_BIN_DIR`, else ~/.local/bin), as the Makefile and tools/dev.sh read it. */
export const BIN_DIR = process.env.G3D_BIN_DIR || path.join(os.homedir(), '.local', 'bin');

/** One installed binary's path. @param {'glyph3d-cli' | 'g3d-termd' | 'g3d'} name */
export const bin = (name) => path.join(BIN_DIR, name);
