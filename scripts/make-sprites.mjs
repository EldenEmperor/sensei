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

// the samurai, side view, facing right; hand at ~(9,5).
// Canvas is 30 wide so up to three summoned mini samurai fit on the right.
const WIDTH = 30;
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
].map((row) => row.padEnd(WIDTH, '.'));

const BLADE_UP = [[10, 5, 'A'], [10, 4, 'I'], [10, 3, 'I'], [10, 2, 'I'], [10, 1, 'I'], [10, 0, 'W']];

// the mini samurai (a summoned clone): same silhouette at half scale, facing
// right, feet on the big one's ground line, own raised blade. `dx` places
// each additional clone further right (0, 5, 10).
const miniBody = (dx) =>
  [
    [15, 3, 'A'], [16, 3, 'W'],                              // topknot glow
    [14, 4, 'W'], [15, 4, 'N'], [16, 4, 'R'], [17, 4, 'W'],  // face + ember eye
    [15, 5, 'B'], [16, 5, 'B'],                              // shoulders
    [14, 6, 'W'], [15, 6, 'B'], [16, 6, 'B'], [17, 6, 'B'],  // torso, arm to the hand at (17,6)
    [15, 7, 'B'], [16, 7, 'B'],                              // waist
    [14, 8, 'B'], [16, 8, 'B'],                              // legs
    [14, 9, 'W'], [16, 9, 'W'],                              // feet
  ].map(([x, y, c]) => [x + dx, y, c]);
const miniBlade = (dx, glint) =>
  (glint
    ? [[18, 5, 'A'], [18, 4, 'W'], [18, 3, 'I'], [18, 2, 'I']]
    : [[18, 5, 'A'], [18, 4, 'I'], [18, 3, 'I'], [18, 2, 'W']]
  ).map(([x, y, c]) => [x + dx, y, c]);
// materializing: every other pixel as spectral glow
const miniGhost = (dx) => miniBody(dx).filter((_, i) => i % 2 === 0).map(([x, y]) => [x, y, 'A']);
const miniSparks = (dx) => [[15 + dx, 5, 'A'], [17 + dx, 3, 'A'], [14 + dx, 8, 'A']];

/** The summon loop for n clones: sparks → spectral outline → solid, then a
 *  standing loop with blade glints alternating across the clones. */
function summonFrames(n) {
  const offsets = [0, 5, 10].slice(0, n);
  const solid = (glintIdx) => [
    ...BLADE_UP,
    ...offsets.flatMap((dx, i) => [...miniBody(dx), ...miniBlade(dx, i === glintIdx)]),
  ];
  return [
    [...BLADE_UP, ...offsets.flatMap(miniSparks)],
    [...BLADE_UP, ...offsets.flatMap((dx) => [...miniGhost(dx), [18 + dx, 3, 'A']])],
    ...offsets.map((_, i) => solid(i)), // glint travels across the clones
    solid(-1),
  ];
}

// an incoming orb (a "blob" of work drifting toward the sensei), diamond-shaped
const orb = (x, y) => [
  [x + 1, y, 'I'],
  [x, y + 1, 'I'], [x + 1, y + 1, 'W'], [x + 2, y + 1, 'A'],
  [x + 1, y + 2, 'A'],
];
// the horizontal strike that cuts it
const BLADE_STRIKE = [[9, 5, 'A'], [10, 5, 'I'], [11, 5, 'I'], [12, 5, 'I'], [13, 5, 'W']];

/** name → { delayMs, mode, frames: overlay[][] } — overlays are [x, y, palette char]. */
const ANIMS = {
  // waiting on the model: work drifts in as an orb and gets SLICED —
  // approach, coil, strike, the halves tumble apart, reset, breathe
  thinking: {
    delayMs: 150,
    mode: 'loop',
    frames: [
      [...BLADE_UP, ...orb(24, 4)], // an orb appears far right
      [...BLADE_UP, ...orb(21, 4)], // drifting in
      [[10, 5, 'A'], [10, 4, 'I'], [10, 3, 'I'], [10, 2, 'W'], [10, 1, 'I'], [10, 0, 'I'], ...orb(18, 4)], // coil: glint charges
      [...BLADE_STRIKE, ...orb(15, 4).map(([x, y]) => [x, y, 'W']), [14, 4, 'W'], [14, 6, 'W']], // STRIKE — white flash
      [
        ...BLADE_STRIKE,
        [15, 3, 'I'], [16, 2, 'A'], // upper half flies up-right
        [15, 7, 'I'], [16, 8, 'A'], // lower half falls down-right
        [14, 5, 'W'], // spark at the cut
      ],
      [
        [10, 5, 'A'], [10, 4, 'I'], [11, 3, 'I'], // blade returning
        [17, 1, 'I'], [18, 2, 'A'],
        [17, 9, 'I'], [18, 8, 'A'],
      ],
      [...BLADE_UP, [19, 1, 'A'], [19, 9, 'A']], // last embers of the halves
      BLADE_UP, // clean breath before the next one
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
  // subagents at work: mini samurai materialize beside the big one — one
  // clone per active subagent (summon / summon2 / summon3)
  summon: { delayMs: 160, mode: 'loop', frames: summonFrames(1) },
  summon2: { delayMs: 160, mode: 'loop', frames: summonFrames(2) },
  summon3: { delayMs: 160, mode: 'loop', frames: summonFrames(3) },
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
