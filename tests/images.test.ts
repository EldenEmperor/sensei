// Image inputs: @path.png attaches as content parts (user messages only),
// both wires translate them, sessions round-trip them, and the accounting
// stays honest.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SenseiAgent } from '../src/core/agent.js';
import { toAnthropicRequest, type AnthropicBlock } from '../src/core/chat/anthropicTranslate.js';
import { toWireMessages } from '../src/core/chat/openaiClient.js';
import { loadSessionFile, saveSession, validateTranscript, type SessionEnvelope } from '../src/core/sessions.js';
import { messageCharCount } from '../src/core/transcript.js';
import { contentToText, type ChatMessage, type ContentPart } from '../src/core/types.js';
import { FakeChatClient, makeStore, makeTempDir, RecordingHost, stopResponse } from './helpers.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function makeAgent(tmp: string) {
  const fake = new FakeChatClient();
  const host = new RecordingHost();
  const agent = new SenseiAgent({
    configStore: makeStore(tmp),
    host,
    permissionPolicy: { mode: 'yolo' },
    chatClient: fake,
  });
  return { agent, fake, host };
}

describe('image attachment via @path', () => {
  it('attaches images as parts (image first, text after, @token retained)', async () => {
    const tmp = makeTempDir('sensei-img-');
    fs.writeFileSync(path.join(tmp, 'shot.png'), PNG_BYTES);
    const { agent, fake, host } = makeAgent(tmp);
    fake.enqueue(stopResponse('a screenshot'));
    await agent.ask('what is in @shot.png ?');
    const user = agent.messages.find((m) => m.role === 'user')!;
    expect(Array.isArray(user.content)).toBe(true);
    const parts = user.content as ContentPart[];
    expect(parts[0]).toEqual({ type: 'image', media_type: 'image/png', data: PNG_BYTES.toString('base64') });
    expect(parts[1].type).toBe('text');
    expect((parts[1] as { text: string }).text).toContain('@shot.png'); // token stays for reference
    expect(host.notes().some((n) => n.includes('attached image'))).toBe(true);
  });

  it('no images → the user message stays a plain string', async () => {
    const tmp = makeTempDir('sensei-img2-');
    const { agent, fake } = makeAgent(tmp);
    fake.enqueue(stopResponse('ok'));
    await agent.ask('plain question');
    expect(typeof agent.messages.find((m) => m.role === 'user')!.content).toBe('string');
  });

  it('oversized images are declined with a note in the text', async () => {
    const tmp = makeTempDir('sensei-img3-');
    fs.writeFileSync(path.join(tmp, 'huge.png'), Buffer.alloc(5 * 1024 * 1024));
    const { agent, fake } = makeAgent(tmp);
    fake.enqueue(stopResponse('ok'));
    await agent.ask('look at @huge.png');
    const user = agent.messages.find((m) => m.role === 'user')!;
    expect(typeof user.content).toBe('string'); // no image part attached
    expect(user.content).toContain('too large to attach');
  });

  it('quoted @"paths with spaces" attach (Copy-as-path / Ctrl+V flow)', async () => {
    const tmp = makeTempDir('sensei-img5-');
    fs.mkdirSync(path.join(tmp, 'my shots'));
    fs.writeFileSync(path.join(tmp, 'my shots', 'screen 1.png'), PNG_BYTES);
    const { agent, fake } = makeAgent(tmp);
    fake.enqueue(stopResponse('ok'));
    await agent.ask('what is @"my shots/screen 1.png" showing?');
    const parts = agent.messages.find((m) => m.role === 'user')!.content as ContentPart[];
    expect(parts[0]).toMatchObject({ type: 'image', media_type: 'image/png' });
    expect((parts[1] as { text: string }).text).toContain('what is @"my shots/screen 1.png" showing?');
  });

  it('jpg/webp extensions map media types; --file works via the same path', async () => {
    const tmp = makeTempDir('sensei-img4-');
    fs.writeFileSync(path.join(tmp, 'photo.JPG'), PNG_BYTES);
    const { agent, fake } = makeAgent(tmp);
    fake.enqueue(stopResponse('ok'));
    await agent.ask('describe this', { files: ['photo.JPG'] });
    const parts = agent.messages.find((m) => m.role === 'user')!.content as ContentPart[];
    expect(parts[0]).toMatchObject({ type: 'image', media_type: 'image/jpeg' });
  });
});

describe('wire translation of image parts', () => {
  const partsMsg: ChatMessage = {
    role: 'user',
    content: [
      { type: 'image', media_type: 'image/png', data: 'AAAA' },
      { type: 'text', text: 'what is this?' },
    ],
  };

  it('anthropic: base64 source block + text block; cache breakpoint on the final block', () => {
    const req = toAnthropicRequest([{ role: 'system', content: 's' }, partsMsg], [], {
      model: 'claude-opus-5',
      maxTokens: 100,
      promptCaching: true,
    });
    const blocks = req.messages[0].content as AnthropicBlock[];
    expect(blocks[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    expect(blocks[1]).toMatchObject({ type: 'text', text: 'what is this?', cache_control: { type: 'ephemeral' } });
  });

  it('openai wire: image_url data URL + text; strings pass through untouched', () => {
    const wire = toWireMessages([{ role: 'system', content: 's' }, partsMsg]) as {
      content: unknown;
    }[];
    expect(wire[0].content).toBe('s');
    expect(wire[1].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: 'what is this?' },
    ]);
  });
});

describe('bookkeeping with image parts', () => {
  it('contentToText and messageCharCount handle parts', () => {
    const m: ChatMessage = {
      role: 'user',
      content: [
        { type: 'image', media_type: 'image/png', data: 'x'.repeat(100) },
        { type: 'text', text: 'hello' },
      ],
    };
    expect(contentToText(m.content)).toBe('[image: image/png]\nhello');
    expect(messageCharCount(m)).toBe(105); // base64 weight counts toward the budget
  });

  it('sessions round-trip content parts', () => {
    const dir = makeTempDir('sensei-img-sess-');
    const parts: ContentPart[] = [
      { type: 'image', media_type: 'image/png', data: 'QUJD' },
      { type: 'text', text: 'see image' },
    ];
    const env: SessionEnvelope = {
      schema_version: 1,
      id: 'aaaabbbbcccc',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      cwd: dir,
      model: 'claude-opus-5',
      local: false,
      messages: [{ role: 'user', content: parts }, { role: 'assistant', content: 'a chart' }],
    };
    const file = saveSession(dir, env);
    const loaded = loadSessionFile(file);
    expect(loaded.messages[0].content).toEqual(parts);
    // validateTranscript alone also preserves them
    expect(validateTranscript([{ role: 'user', content: parts }])[0].content).toEqual(parts);
  });
});

describe('read_file on an image', () => {
  it('returns the attach hint instead of binary garbage', async () => {
    const tmp = makeTempDir('sensei-img-read-');
    fs.writeFileSync(path.join(tmp, 'pic.webp'), PNG_BYTES);
    const { agent } = makeAgent(tmp);
    const tool = agent.registry.get('read_file')!;
    const out = String(
      await tool.handler(
        { path: 'pic.webp' },
        { cwd: tmp, configDir: agent.store.configDir, config: agent.store.config, local: false, emitNote: () => {}, setTodos: () => {} },
      ),
    );
    expect(out).toContain('@pic.webp');
    expect(out).toContain('binary image');
  });
});
