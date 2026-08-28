// Generates assets/banner.txt as truecolor ANSI half-block pixel art.
// Original design: an electric-blue spectral samurai kabuto (helmet + shoulder
// plates, glowing crest, red eyes). Edit the GRID and PALETTE, then run:
//   node scripts/make-banner.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PALETTE = {
  '.': null, // transparent
  N: [0x0a, 0x1a, 0x3f], // deep navy (face shadow)
  B: [0x1e, 0x4f, 0xd8], // armor blue
  A: [0x5b, 0x8d, 0xef], // sensei accent blue (edge glow)
  I: [0xbf, 0xe0, 0xff], // ice highlight
  W: [0xff, 0xff, 0xff], // white hot
  R: [0xe0, 0x53, 0x3d], // eye ember
};

// 26 wide × 19 tall; every two rows collapse into one text line via ▀.
const GRID = [
  '..........W.....W.........',
  '.........WIW...WIW........',
  '..........WIWWWIW.........',
  '........WWIIAAIIWW........',
  '......WAAAAAAAAAAAAW......',
  '.....WAABBBBBBBBBBAAW.....',
  '....WABBBBBBBBBBBBBBAW....',
  '....WABBNNNNNNNNNNBBAW....',
  '...WAABNNNNNNNNNNNNBAAW...',
  '...WABN.RR.NNNN.RR.NBAW...',
  '...WABNN..NNNNNN..NNBAW...',
  '....WABNNNNNNNNNNNNBAW....',
  '....WAABNNNWWWWNNNBAAW....',
  '.....WAABBBBBBBBBBAAW.....',
  '...WWAABBAABBBBAABBAAWW...',
  '..WAABBAAW.ABBA.WAABBAAW..',
  '.WAABBAW...ABBA...WABBAAW.',
  '.WABBA.....ABBA.....ABBAW.',
  '.WABA......ABBA......ABAW.',
];

const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const fg = ([r, g, b]) => `${ESC}[38;2;${r};${g};${b}m`;
const bg = ([r, g, b]) => `${ESC}[48;2;${r};${g};${b}m`;

const lines = [];
for (let y = 0; y < GRID.length; y += 2) {
  const top = GRID[y];
  const bottom = GRID[y + 1] ?? '.'.repeat(top.length);
  let line = '';
  let open = false;
  for (let x = 0; x < top.length; x++) {
    const t = PALETTE[top[x]];
    const b = PALETTE[bottom[x]];
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

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..', 'assets', 'banner.txt');
fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
console.log(`wrote ${lines.length} lines to ${out}`);
console.log(lines.join('\n'));
