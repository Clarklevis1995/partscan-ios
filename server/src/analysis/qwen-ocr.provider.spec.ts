import { ConfigService } from '@nestjs/config';
import { QwenOcrProvider } from './qwen-ocr.provider';

describe('QwenOcrProvider geometry normalization', () => {
  const provider = new QwenOcrProvider(new ConfigService());

  it('extracts the plate dictionary and combines adjacent plate and number boxes', () => {
    const raw = `\`\`\`json
[
  {"rotate_rect":[588,31,27,408,88],"text":"A1 A2 C3 G1 G3 G5 G6"},
  {"rotate_rect":[340,242,19,57,90],"text":"G6 4"},
  {"rotate_rect":[104,322,19,35,90],"text":"A1"},
  {"rotate_rect":[134,322,13,13,90],"text":"7"},
  {"rotate_rect":[670,598,19,35,90],"text":"G3"},
  {"rotate_rect":[702,598,14,13,90],"text":"3"},
  {"rotate_rect":[88,401,22,17,90],"text":"1"}
]
\`\`\``;

    const result = provider.extractEvidence(raw);
    expect(result.plateDictionary).toEqual(['A1', 'A2', 'C3', 'G1', 'G3', 'G5', 'G6']);
    expect(result.labels).toEqual(expect.arrayContaining(['G6(4)', 'A1(7)', 'G3(3)']));
    expect(result.labels).not.toContain('A1(1)');
    expect(result.boxes).toHaveLength(7);
  });

  it('supports plain parenthesized OCR output without coordinates', () => {
    const result = provider.extractEvidence('A3(23)\nG6（4）');
    expect(result.labels).toEqual(['A3(23)', 'G6(4)']);
    expect(result.boxes).toEqual([]);
  });

  it('rebuilds a split header row and splits merged OCR labels with that dictionary', () => {
    const raw = JSON.stringify([
      { rotate_rect: [500, 24, 20, 30, 90], text: 'A1' },
      { rotate_rect: [550, 23, 20, 30, 90], text: 'A2' },
      { rotate_rect: [600, 25, 20, 30, 90], text: 'C3' },
      { rotate_rect: [650, 22, 20, 30, 90], text: 'G6' },
      { rotate_rect: [640, 402, 19, 59, 90], text: 'A114' },
      { rotate_rect: [700, 500, 19, 55, 90], text: 'G64' },
      { rotate_rect: [780, 500, 14, 13, 90], text: '8' },
    ]);

    const result = provider.extractEvidence(raw);
    expect(result.plateDictionary).toEqual(['A1', 'A2', 'C3', 'G6']);
    expect(result.labels).toEqual(expect.arrayContaining(['A1(14)', 'G6(4)']));
    expect(result.labels).not.toContain('G64(8)');
  });

});
