// Pure tests for the slash-command menu: query parsing, source merging with
// shadowing, prefix filtering + selection clamping + scroll windowing, and
// completion.

import { describe, expect, it } from 'vitest';
import {
  applySlashCompletion,
  BUILTIN_COMMANDS,
  buildSlashItems,
  helpLines,
  slashMenuQuery,
  slashMenuView,
  type SlashItem,
} from '../src/tui/slashMenu.js';

describe('slashMenuQuery', () => {
  it('parses the query and closes on space/newline/non-slash', () => {
    expect(slashMenuQuery('/')).toBe('');
    expect(slashMenuQuery('/he')).toBe('he');
    expect(slashMenuQuery('/help ')).toBeNull();
    expect(slashMenuQuery('/resume 3')).toBeNull();
    expect(slashMenuQuery('hi')).toBeNull();
    expect(slashMenuQuery('/a\nb')).toBeNull();
    expect(slashMenuQuery('')).toBeNull();
  });
});

describe('buildSlashItems', () => {
  it('merges builtin > custom > skill, dropping shadowed names', () => {
    const items = buildSlashItems(
      BUILTIN_COMMANDS,
      [
        { name: 'clear', argumentHint: '', description: 'shadowed custom' },
        { name: 'triage', argumentHint: '<file>', description: 'triage a log' },
        { name: 'dupe', argumentHint: '', description: 'custom wins' },
      ],
      [
        { name: 'dupe', description: 'shadowed skill' },
        { name: 'sre-runbook', description: 'a skill' },
      ],
    );
    const byName = new Map(items.map((i) => [i.name, i]));
    expect(byName.get('clear')!.source).toBe('builtin');
    expect(byName.get('dupe')!.source).toBe('custom');
    expect(byName.get('triage')).toEqual({ name: 'triage', hint: '<file>', desc: 'triage a log', source: 'custom' });
    expect(byName.get('sre-runbook')!.source).toBe('skill');
    // order: all builtins first, then customs, then skills
    expect(items.findIndex((i) => i.source === 'custom')).toBeGreaterThan(
      items.map((i) => i.source).lastIndexOf('builtin'),
    );
  });
});

describe('slashMenuView', () => {
  it('filters by prefix and clamps the selection at both ends', () => {
    const v = slashMenuView('/c', BUILTIN_COMMANDS, 0)!;
    const names = v.items.map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(['clear', 'color', 'config', 'cost', 'compact']));
    expect(names.every((n) => n.startsWith('c'))).toBe(true);
    expect(slashMenuView('/c', BUILTIN_COMMANDS, -5)!.selected).toBe(0);
    expect(slashMenuView('/c', BUILTIN_COMMANDS, 99)!.selected).toBe(v.items.length - 1);
  });

  it('windows the rows around the selection with moreBelow', () => {
    const many: SlashItem[] = Array.from({ length: 12 }, (_, i) => ({
      name: `cmd${String(i).padStart(2, '0')}`,
      hint: '',
      desc: `d${i}`,
      source: 'builtin' as const,
    }));
    const top = slashMenuView('/cmd', many, 0, 8)!;
    expect(top.rows).toHaveLength(8);
    expect(top.start).toBe(0);
    expect(top.moreBelow).toBe(4);
    const deep = slashMenuView('/cmd', many, 10, 8)!;
    expect(deep.rows).toHaveLength(8);
    expect(deep.start).toBe(3);
    expect(deep.rows.map((r) => r.name)).toContain('cmd10');
    expect(deep.moreBelow).toBe(1);
    const last = slashMenuView('/cmd', many, 11, 8)!;
    expect(last.start).toBe(4);
    expect(last.moreBelow).toBe(0);
  });

  it('returns null with no matches, and bare / lists everything', () => {
    expect(slashMenuView('/zzz', BUILTIN_COMMANDS, 0)).toBeNull();
    expect(slashMenuView('hello', BUILTIN_COMMANDS, 0)).toBeNull();
    expect(slashMenuView('/', BUILTIN_COMMANDS, 0)!.items).toHaveLength(BUILTIN_COMMANDS.length);
  });
});

describe('applySlashCompletion', () => {
  it('completes to /name with a trailing space and cursor at end', () => {
    const item = BUILTIN_COMMANDS.find((c) => c.name === 'help')!;
    expect(applySlashCompletion({ text: '/he', cursor: 3 }, item)).toEqual({ text: '/help ', cursor: 6 });
  });
});

describe('helpLines', () => {
  it('keeps the strings the TUI tests assert on', () => {
    const joined = helpLines().join('\n');
    expect(joined).toContain('/clear');
    expect(joined).toContain('toggle plan mode');
    expect(joined).toContain('custom commands');
  });
});
