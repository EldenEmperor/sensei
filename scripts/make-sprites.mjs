// Generates assets/sprites.txt: small ANSI half-block sprite animations the
// TUI plays while Sensei works. One shared base body (16x12 px → 6 rows) with
// per-frame blade/effect overlays, so every animation stays on-model.
//   node scripts/make-sprites.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PALETTE = {
  '.': null,
  N: [0x0a, 0x1a, 0x3f], // face shadow
  B: [0x1e, 0x4f, 0xd8], // armor blue
  A: [0x5b, 0x8d, 0xef], // accent glow
  I: [0xbf, 0xe0, 0xff], // ice
  W: [0xff, 0xff, 0xff], // white hot
  R: [0xe0, 0x53, 0x3d], // eye ember
};

// the samurai, side view, facing right; hand at ~(9,5)
const BASE = [
  '.....W..........',
  '....WAW.........',
  '...WAAAW........',
  '...WNNRW........',
  '....WBBW........',
  '...WBBBBBB......',
  '...WBBBBW.......',
  '....WBBW........',
  '....WBWBW.......',
  '...WBW.WBW......',
  '...WW...WW......',
  '................',
];

const BLADE_UP = [[10, 5, 'A'], [10, 4, 'I'], [10, 3, 'I'], [10, 2, 'I'], [10, 1, 'I'], [10, 0, 'W']];

/** name → { delayMs, mode, frames: overlay[][] } — overlays are [x, y, palette char]. */
const ANIMS = {
  // waiting on the model: blade held high, glint travelling
  thinking: {
    delayMs: 220,
    mode: 'loop',
    frames: [
      BLADE_UP,
      [[10, 5, 'A'], [10, 4, 'I'], [10, 3, 'W'], [10, 2, 'I'], [10, 1, 'I'], [10, 0, 'I']],
      [[10, 5, 'A'], [10, 4, 'I'], [10, 3, 'I'], [10, 2, 'I'], [10, 1, 'W'], [10, 0, 'I']],
    ],
  },
  // a tool is running: full sword arc with trail and sparks
  slash: {
    delayMs: 90,
    mode: 'loop',
    frames: [
      [[9, 5, 'A'], [10, 4, 'I'], [11, 3, 'I'], [12, 2, 'I'], [13, 1, 'W']],
      [[10, 5, 'A'], [11, 5, 'I'], [12, 5, 'I'], [13, 5, 'I'], [14, 5, 'W'], [11, 3, 'A'], [12, 2, 'A']],
      [[10, 6, 'A'], [11, 7, 'I'], [12, 8, 'I'], [13, 9, 'W'], [12, 3, 'A'], [13, 4, 'A'], [14, 5, 'A']],
      [[10, 8, 'I'], [11, 8, 'I'], [12, 8, 'I'], [13, 7, 'W'], [14, 9, 'W'], [13, 10, 'I'], [12, 4, 'A']],
    ],
  },
  // subagents at work: a spectral clone materializes
  summon: {
    delayMs: 160,
    mode: 'loop',
    frames: [
      [...BLADE_UP, [12, 6, 'A'], [13, 8, 'A']],
      [...BLADE_UP, [12, 4, 'A'], [11, 6, 'A'], [13, 6, 'A'], [12, 8, 'A'], [11, 9, 'A'], [13, 9, 'A']],
      [
        ...BLADE_UP,
        [12, 3, 'A'], [13, 3, 'A'],
        [11, 4, 'A'], [12, 4, 'I'], [13, 4, 'A'],
        [12, 5, 'A'], [13, 5, 'A'],
        [11, 6, 'A'], [12, 6, 'A'], [13, 6, 'A'], [14, 6, 'A'],
        [12, 7, 'A'], [13, 7, 'A'],
        [11, 8, 'A'], [14, 8, 'A'],
        [11, 9, 'A'], [14, 9, 'A'],
      ],
    ],
  },
  // the answer landed: blade away, clean click (played once)
  sheath: {
    delayMs: 120,
    mode: 'once',
    frames: [
      [[10, 5, 'A'], [11, 5, 'I'], [12, 5, 'I'], [13, 5, 'I'], [14, 5, 'W']],
      [[10, 5, 'A'], [11, 5, 'W']],
      [[9, 5, 'W'], [10, 4, 'I']],
    ],
  },
};

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const fg = ([r, g, b]) => `${ESC}[38;2;${r};${g};${b}m`;
const bg = ([r, g, b]) => `${ESC}[48;2;${r};${g};${b}m`;

function compose(overlay) {
  const grid = BASE.map((row) => row.split(''));
  for (const [x, y, c] of overlay) grid[y][x] = c;
  return grid;
}

function renderHalfBlocks(grid) {
  const lines = [];
  for (let y = 0; y < grid.length; y += 2) {
    let line = '';
    let open = false;
    for (let x = 0; x < grid[y].length; x++) {
      const t = PALETTE[grid[y][x]];
      const b = PALETTE[grid[y + 1]?.[x] ?? '.'];
      if (!t && !b) {
        if (open) {
          line += RESET;
          open = false;
        }
        line += ' ';
      } else if (t && b) {
        line += fg(t) + bg(b) + '▀';
        open = true;
      } else if (t) {
        if (open) line += RESET;
        line += fg(t) + '▀';
        open = true;
      } else {
        if (open) line += RESET;
        line += fg(b) + '▄';
        open = true;
      }
    }
    if (open) line += RESET;
    lines.push(line.replace(/ +$/, ''));
  }
  return lines;
}

const out = ['%%SENSEI-SPRITES v1'];
for (const [name, anim] of Object.entries(ANIMS)) {
  out.push(`%%ANIM ${name} ${anim.delayMs} ${anim.mode}`);
  for (const overlay of anim.frames) {
    out.push('%%FRAME');
    out.push(...renderHalfBlocks(compose(overlay)));
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, '..', 'assets', 'sprites.txt');
fs.writeFileSync(file, out.join('\n') + '\n', 'utf8');
console.log(`wrote ${Object.keys(ANIMS).length} animations to ${file}`);
