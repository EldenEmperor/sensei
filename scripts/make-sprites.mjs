// Generates assets/sprites.txt: small ANSI half-block sprite animations the
// TUI plays while Sensei works. One shared base body (the blue sensei) plus a
// mirrored red rival, with per-frame blade/effect overlays so every animation
// stays on-model.
//   node scripts/make-sprites.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PALETTE = {
  '.': null,
  N: [0x0a, 0x1a, 0x3f], // face shadow (blue)
  B: [0x1e, 0x4f, 0xd8], // armor blue
  A: [0x5b, 0x8d, 0xef], // accent glow (blue) — and the red rival's cold eye
  I: [0xbf, 0xe0, 0xff], // ice (blades)
  W: [0xff, 0xff, 0xff], // white hot
  R: [0xe0, 0x53, 0x3d], // eye ember (blue's eye)
  E: [0xd8, 0x3a, 0x30], // armor red (the rival)
  D: [0x52, 0x10, 0x0e], // face shadow (red)
  O: [0xff, 0x9a, 0x4d], // warm orange glow (red accent)
};

// the blue sensei, side view, facing right; hand at ~(9,5).
// Canvas is 34 wide: room for the red rival and the mini melee.
const WIDTH = 34;
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
// blue's forward strike (hand at (9,5), blade horizontal)
const BLADE_STRIKE = [[9, 5, 'A'], [10, 5, 'I'], [11, 5, 'I'], [12, 5, 'I'], [13, 5, 'W']];
// blue's forward feint (blade angled up-forward)
const BLADE_FEINT = [[10, 5, 'A'], [10, 4, 'I'], [11, 3, 'I'], [12, 2, 'W']];

// --- the red rival ----------------------------------------------------------
// A perfect mirror of the blue silhouette, facing LEFT, in red — with a cold
// blue eye (the inverse of blue's ember). Derived from BASE so the two can
// never drift apart. dx shifts the whole figure (lunge in / fall back).
const RED_SWAP = { W: 'W', A: 'O', N: 'D', B: 'E', R: 'A' };
const RED_PIVOT = 26; // maps blue x3..x10 → red x23..x16... hand mirrors 9 → 17

function redBody(dx) {
  const out = [];
  for (let y = 0; y <= 10; y++) {
    const row = BASE[y];
    for (let x = 3; x <= 10; x++) {
      const c = row[x];
      if (c && c !== '.') out.push([RED_PIVOT - x + dx, y, RED_SWAP[c] ?? c]);
    }
  }
  return out;
}
// red's blade column mirrors blue's x10 → x16
const redBladeUp = (dx) =>
  [[16, 5, 'O'], [16, 4, 'I'], [16, 3, 'I'], [16, 2, 'I'], [16, 1, 'I'], [16, 0, 'W']].map(([x, y, c]) => [x + dx, y, c]);
// red's strike toward blue (hand mirrors to (17,5), blade pointing left)
const redBladeStrike = (dx) =>
  [[17, 5, 'O'], [16, 5, 'I'], [15, 5, 'I'], [14, 5, 'I'], [13, 5, 'W']].map(([x, y, c]) => [x + dx, y, c]);
// red's parry angled down-left toward an incoming cut
const redBladeParry = (dx) =>
  [[16, 5, 'O'], [15, 4, 'I'], [14, 3, 'I'], [13, 2, 'W']].map(([x, y, c]) => [x + dx, y, c]);

// --- the spyglass -----------------------------------------------------------
// A long telescope raised to the eye, pointing right; the glint travels out.
const SPYGLASS = [[8, 3, 'A'], [9, 3, 'I'], [10, 3, 'I'], [11, 3, 'A'], [12, 3, 'I'], [13, 3, 'I'], [14, 3, 'I'], [15, 3, 'W']];
const spyglassGlint = (at) => SPYGLASS.map(([x, y, c]) => [x, y, x === at ? 'W' : c]);

// --- the minis --------------------------------------------------------------
// Half-scale samurai. Blue minis face right; the shared red mini faces left.
const miniBody = (dx, dy = 0) =>
  [
    [15, 3, 'A'], [16, 3, 'W'],                              // topknot glow
    [14, 4, 'W'], [15, 4, 'N'], [16, 4, 'R'], [17, 4, 'W'],  // face + ember eye
    [15, 5, 'B'], [16, 5, 'B'],                              // shoulders
    [14, 6, 'W'], [15, 6, 'B'], [16, 6, 'B'], [17, 6, 'B'],  // torso, hand at (17,6)
    [15, 7, 'B'], [16, 7, 'B'],                              // waist
    [14, 8, 'B'], [16, 8, 'B'],                              // legs
    [14, 9, 'W'], [16, 9, 'W'],                              // feet
  ].map(([x, y, c]) => [x + dx, y + dy, c]);
const miniBlade = (dx, dy = 0) =>
  [[18, 5, 'A'], [18, 4, 'I'], [18, 3, 'I'], [18, 2, 'W']].map(([x, y, c]) => [x + dx, y + dy, c]);
// a mini's horizontal jab from the hand at (17+dx, 6+dy)
const miniJab = (dx, dy = 0) =>
  [[18, 6, 'A'], [19, 6, 'I'], [20, 6, 'I'], [21, 6, 'W']].map(([x, y, c]) => [x + dx, y + dy, c]);
// spectral materialization
const miniGhost = (dx, dy = 0) => miniBody(dx, dy).filter((_, i) => i % 2 === 0).map(([x, y]) => [x, y, 'A']);

// the shared red mini the clones gang up on: mirror of miniBody at the right
// edge (body x26..29, blade x25 pointing left), cold blue eye
const MINI_RED_PIVOT = 43;
const MINI_RED = miniBody(0).map(([x, y, c]) => [MINI_RED_PIVOT - x, y, RED_SWAP[c] ?? c]);
const MINI_RED_BLADE_HIGH = [[25, 5, 'O'], [25, 4, 'I'], [25, 3, 'I'], [25, 2, 'W']];
const MINI_RED_BLADE_LOW = [[25, 6, 'O'], [24, 6, 'I'], [23, 6, 'I'], [22, 7, 'W']];

/** The mini melee for n clones: the blues materialize, then swarm the red —
 *  a ground fighter lunging with jabs, a diving attacker from above, and a
 *  reserve pressing in, everyone shifting position frame to frame. */
function summonFrames(n) {
  const redHigh = [...MINI_RED, ...MINI_RED_BLADE_HIGH];
  const redLow = [...MINI_RED, ...MINI_RED_BLADE_LOW];
  // attacker poses per frame: [ground dx, aerial present dy-bob, reserve dx]
  const ground = (dx, jab) => [...miniBody(dx), ...(jab ? miniJab(dx) : miniBlade(dx))];
  const aerial = (dy) => [...miniBody(7, dy), [25, 7 + dy, 'I'], [25, 8 + dy, 'W']]; // down-blade meets the red's guard
  const reserve = (dx) => [...miniBody(dx, 0), ...miniBlade(dx)];

  const fighters = (f) => {
    const out = [...ground(f.g, f.jab)];
    if (n >= 2) out.push(...aerial(f.a));
    if (n >= 3) out.push(...reserve(f.r));
    return out;
  };

  const frames = [
    // materialize
    [...BLADE_UP, ...redHigh, [16, 5, 'A'], [18, 3, 'A'], [15, 8, 'A']],
    [...BLADE_UP, ...redHigh, ...miniGhost(0), ...(n >= 2 ? miniGhost(9, -3) : []), ...(n >= 3 ? miniGhost(-2) : [])],
    // the melee: lunge / dive / press, red parrying high and low
    [...BLADE_UP, ...redLow, ...fighters({ g: 2, jab: true, a: -3, r: -2 }), [22, 6, 'W']],
    [...BLADE_UP, ...redHigh, ...fighters({ g: 3, jab: true, a: -2, r: -1 }), [24, 5, 'W'], [26, 3, 'A']],
    [...BLADE_UP, ...redLow, ...fighters({ g: 2, jab: false, a: -3, r: 0 }), [23, 7, 'A']],
    [...BLADE_UP, ...redHigh, ...fighters({ g: 4, jab: true, a: -2, r: -1 }), [25, 5, 'W'], [24, 6, 'A']],
  ];
  return frames;
}

/** name → { delayMs, mode, frames: overlay[][] } — overlays are [x, y, palette char]. */
const ANIMS = {
  // waiting on the model: the DUEL, measured — the red rival circles in, blades
  // cross with a spark, push-off, feint, re-clash, breath
  thinking: {
    delayMs: 160,
    mode: 'loop',
    frames: [
      [...BLADE_UP, ...redBody(6), ...redBladeUp(6)], // red at range
      [...BLADE_UP, ...redBody(3), ...redBladeUp(3)], // stepping in
      [...BLADE_STRIKE, ...redBody(1), ...redBladeParry(1), [13, 4, 'W'], [14, 5, 'W']], // CLASH — spark where the blades meet
      [...BLADE_UP, ...redBody(4), ...redBladeUp(4), [13, 4, 'A']], // push-off, spark fading
      [...BLADE_FEINT, ...redBody(2), ...redBladeParry(2), [13, 2, 'W']], // high feint met high
      [...BLADE_UP, ...redBody(5), ...redBladeUp(5)], // circling out
      [[10, 5, 'A'], [10, 4, 'I'], [10, 3, 'W'], [10, 2, 'I'], [10, 1, 'I'], [10, 0, 'I'], ...redBody(6), ...redBladeUp(6)], // breath, glint
    ],
  },
  // a tool is executing: the duel at full tempo — strike, counter, cross, break
  slash: {
    delayMs: 100,
    mode: 'loop',
    frames: [
      [...BLADE_STRIKE, ...redBody(2), ...redBladeParry(2), [13, 4, 'W'], [14, 5, 'W']], // blue strikes, red parries
      [...BLADE_UP, ...redBody(0), ...redBladeStrike(0), [11, 5, 'W'], [12, 4, 'W']], // red counters at blue's guard
      [...BLADE_FEINT, ...redBody(1), ...redBladeParry(1), [12, 2, 'W'], [13, 3, 'A'], [12, 3, 'A']], // blades cross high
      [...BLADE_UP, ...redBody(4), ...redBladeUp(4), [12, 4, 'A']], // break apart
    ],
  },
  // observing (grep/fetch/log reads): the long spyglass comes up, the glint
  // travels out the tube, something twinkles in the distance
  scout: {
    delayMs: 200,
    mode: 'loop',
    frames: [
      [...spyglassGlint(9)],
      [...spyglassGlint(12), [22, 2, 'A']],
      [...spyglassGlint(15), [22, 2, 'W'], [23, 3, 'A']],
      [...SPYGLASS, [22, 2, 'A']],
    ],
  },
  // subagents at work: the mini melee — clones (one per active subagent)
  // swarm a red mini, everyone in motion
  summon: { delayMs: 150, mode: 'loop', frames: summonFrames(1) },
  summon2: { delayMs: 150, mode: 'loop', frames: summonFrames(2) },
  summon3: { delayMs: 150, mode: 'loop', frames: summonFrames(3) },
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
  for (const [x, y, c] of overlay) {
    if (y >= 0 && y < grid.length && x >= 0 && x < WIDTH) grid[y][x] = c;
  }
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

// --- debug: render frames as plain chars with `node scripts/make-sprites.mjs --show <anim>`
const showIdx = process.argv.indexOf('--show');
if (showIdx >= 0) {
  const name = process.argv[showIdx + 1] ?? 'thinking';
  for (const [i, overlay] of (ANIMS[name]?.frames ?? []).entries()) {
    console.log(`--- ${name} frame ${i}`);
    console.log(compose(overlay).map((r) => r.join('')).join('\n'));
  }
}
