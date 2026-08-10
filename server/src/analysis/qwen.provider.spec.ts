import { ConfigService } from '@nestjs/config';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QwenProvider } from './qwen.provider';

describe('QwenProvider batching', () => {
  let directory: string;
  const originalFetch = global.fetch;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'partscan-qwen-batch-'));
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  });

  it('analyzes consecutive batches with global page numbers and summarizes section identities', async () => {
    const paths = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
      const path = join(directory, `page-${index + 1}.jpg`);
      await writeFile(path, Buffer.from(`page ${index + 1}`));
      return path;
    }));
    const replies = [
      { sections: [{ name: '头部骨架', sourcePages: [1, 2], plates: [{ code: 'A1', parts: [{ number: '7', quantity: 1, sourcePages: [1] }] }] }], uncertainItems: [] },
      { sections: [{ name: '头部外甲', sourcePages: [3, 4], plates: [{ code: 'A2', parts: [{ number: '3', quantity: 1, sourcePages: [3] }] }] }], uncertainItems: [] },
      { sections: [{ name: '手臂', sourcePages: [5], plates: [{ code: 'B1', parts: [{ number: '4', quantity: 1, sourcePages: [5] }] }] }], uncertainItems: [] },
      { groups: [{ name: '头部', sectionIds: ['b1s1', 'b2s1'] }, { name: '手臂', sectionIds: ['b3s1'] }] },
    ];
    const requestBodies: Array<{ messages: Array<{ content: unknown }> }> = [];
    global.fetch = jest.fn(async (_url, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as { messages: Array<{ content: unknown }> });
      const reply = replies[requestBodies.length - 1];
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }) } as Response;
    });

    const provider = new QwenProvider(new ConfigService({
      QWEN_MOCK: 'false', DASHSCOPE_API_KEY: 'test-key', NODE_ENV: 'production',
    }));
    const result = await provider.analyze(paths, 'qwen3.7-flash', {
      reasoningEffort: 'medium', vlmBatchSize: 2, multiScaleEnabled: true,
    });

    expect(global.fetch).toHaveBeenCalledTimes(4);
    const secondBatchContent = requestBodies[1].messages[1].content as Array<{ type: string; text?: string }>;
    expect(secondBatchContent.some((item) => item.text?.includes('跨批上下文页（全书第2页）'))).toBe(true);
    expect(secondBatchContent.some((item) => item.text?.startsWith('说明书第3页 · 完整页'))).toBe(true);
    expect(result.sections.map((section) => section.name)).toEqual(['头部', '手臂']);
    expect(result.sections[0].sourcePages).toEqual([1, 2, 3, 4]);
    expect(result.sections[0].plates.map((plate) => plate.code)).toEqual(['A1', 'A2']);
  });

  it('maps Qwen 3.8 Max to the Token Plan preview model and enables required thinking mode', async () => {
    const path = join(directory, 'page-1.jpg');
    await writeFile(path, Buffer.from('page 1'));
    let requestBody: Record<string, unknown> = {};
    global.fetch = jest.fn(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ sections: [], uncertainItems: [] }) } }] }),
      } as Response;
    });
    const provider = new QwenProvider(new ConfigService({
      QWEN_MOCK: 'false', DASHSCOPE_API_KEY: 'test-key', QWEN_38_REASONING_EFFORT: 'medium', NODE_ENV: 'production',
    }));

    await provider.analyze([path], 'qwen3.8-max');

    expect(requestBody).toMatchObject({
      model: 'qwen3.8-max-preview',
      enable_thinking: true,
      reasoning_effort: 'medium',
      temperature: 0.6,
    });
  });
});
