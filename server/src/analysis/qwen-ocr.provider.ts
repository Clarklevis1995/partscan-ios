import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

interface QwenOcrResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

export interface OcrRecognitionResult {
  model: string;
  text: string;
  durationMs: number;
  plateDictionary: string[];
  labels: string[];
  boxes: OcrTextBox[];
}

export interface OcrTextBox { text: string; rotateRect: number[] }

@Injectable()
export class QwenOcrProvider {
  private readonly logger = new Logger(QwenOcrProvider.name);
  private readonly concurrency = 3;

  constructor(private readonly config: ConfigService) {}

  async recognizeImage(data: Buffer, mimeType: string): Promise<OcrRecognitionResult> {
    const key = this.config.get<string>('DASHSCOPE_API_KEY');
    if (!key) throw new ServiceUnavailableException('DASHSCOPE_API_KEY is not configured');
    return this.request(data, mimeType, key, 'postman');
  }

  async recognizeStoredPages(paths: string[]): Promise<OcrRecognitionResult[]> {
    const model = this.config.get('QWEN_OCR_MODEL', 'qwen3.5-ocr');
    if (this.config.get('QWEN_MOCK', 'true') === 'true') {
      return Array.from({ length: paths.length }, () => this.emptyResult(model));
    }
    const key = this.config.get<string>('DASHSCOPE_API_KEY');
    if (!key) throw new ServiceUnavailableException('DASHSCOPE_API_KEY is not configured');
    return this.recognizePages(paths, key);
  }

  private async recognizePages(paths: string[], key: string): Promise<OcrRecognitionResult[]> {
    const model = this.config.get('QWEN_OCR_MODEL', 'qwen3.5-ocr');
    const results = Array.from({ length: paths.length }, () => this.emptyResult(model));
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, paths.length) }, async () => {
      while (nextIndex < paths.length) {
        const index = nextIndex++;
        try {
          results[index] = await this.recognizePage(paths[index], index + 1, key);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown OCR error';
          this.logger.warn(`OCR页识别失败 page=${index + 1}: ${message}; 将由VLM直接分析原图`);
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  private async recognizePage(path: string, page: number, key: string): Promise<OcrRecognitionResult> {
    const data = await readFile(path);
    return this.request(data, this.mime(path), key, String(page));
  }

  private async request(data: Buffer, mimeType: string, key: string, page: string): Promise<OcrRecognitionResult> {
    const baseURL = this.config.get('DASHSCOPE_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
    const model = this.config.get('QWEN_OCR_MODEL', 'qwen3.5-ocr');
    const startedAt = Date.now();
    this.logger.log(`OCR页识别开始 model=${model} page=${page} bytes=${data.length}`);
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${data.toString('base64')}` },
              min_pixels: 3072,
              max_pixels: 8388608,
            },
            {
              type: 'text',
              text: '只识别图片中的模型零件标签。逐行输出“字母数字(紧邻黑色圆圈数字)”，例如 A3(23)。不要输出表格、步骤号、解释或本提示文字。',
            },
          ],
        }],
      }),
    });
    const payload = await response.json() as QwenOcrResponse;
    if (!response.ok) throw new Error(payload.error?.message ?? `Qwen OCR request failed (${response.status})`);
    const text = payload.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('Qwen OCR returned an empty response');
    const durationMs = Date.now() - startedAt;
    this.logger.log(`OCR页识别完成 model=${model} page=${page} chars=${text.length} durationMs=${durationMs}`);
    return { model, text, durationMs, ...this.extractEvidence(text) };
  }

  extractEvidence(raw: string): Pick<OcrRecognitionResult, 'plateDictionary' | 'labels' | 'boxes'> {
    const normalized = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let boxes: OcrTextBox[] = [];
    try {
      const value = JSON.parse(normalized) as unknown;
      if (Array.isArray(value)) {
        boxes = value.flatMap((entry): OcrTextBox[] => {
          if (typeof entry !== 'object' || entry === null) return [];
          const item = entry as { text?: unknown; rotate_rect?: unknown };
          if (typeof item.text !== 'string' || !Array.isArray(item.rotate_rect)) return [];
          const rotateRect = item.rotate_rect.map(Number);
          return rotateRect.length >= 4 && rotateRect.every(Number.isFinite)
            ? [{ text: item.text.trim(), rotateRect }]
            : [];
        });
      }
    } catch {
      // Some OCR responses are plain text. Parenthesized labels are still
      // extracted below, but geometry-based pairing is unavailable.
    }

    const dictionaryCandidates = boxes
      .map((box) => box.text.match(/[A-Z]+\d+/gi)?.map((code) => code.toUpperCase()) ?? [])
      .filter((codes) => codes.length >= 2)
      .sort((left, right) => right.length - left.length);
    const singleCodeBoxes = boxes.filter((box) => /^[A-Z]+\d{1,3}$/i.test(box.text));
    const headerRows: OcrTextBox[][] = [];
    for (const box of [...singleCodeBoxes].sort((left, right) => left.rotateRect[1] - right.rotateRect[1])) {
      const row = headerRows.find((candidate) => Math.abs(candidate[0].rotateRect[1] - box.rotateRect[1]) <= 24);
      if (row) row.push(box); else headerRows.push([box]);
    }
    const headerRow = headerRows
      .filter((row) => row.length >= 2)
      .sort((left, right) => right.length - left.length || left[0].rotateRect[1] - right[0].rotateRect[1])[0];
    const splitHeaderCodes = headerRow
      ? headerRow.sort((left, right) => left.rotateRect[0] - right.rotateRect[0]).map((box) => box.text.toUpperCase())
      : [];
    const plateDictionary = [...new Set(dictionaryCandidates[0] ?? splitHeaderCodes)];
    plateDictionary.sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
    const labels = new Set<string>();

    for (const box of boxes) {
      const combined = box.text.toUpperCase().match(/^([A-Z]+\d+)(?:\s+|\s*[（(]\s*)(\d+)[）)]?$/);
      if (combined && (!plateDictionary.length || plateDictionary.includes(combined[1]))) {
        labels.add(`${combined[1]}(${combined[2]})`);
      }
      const merged = box.text.toUpperCase();
      const dictionaryPrefix = [...plateDictionary]
        .sort((left, right) => right.length - left.length)
        .find((code) => merged.startsWith(code) && /^\d{1,3}$/.test(merged.slice(code.length)));
      if (dictionaryPrefix) labels.add(`${dictionaryPrefix}(${merged.slice(dictionaryPrefix.length)})`);
    }

    const plateBoxes = boxes.filter((box) => {
      const code = box.text.toUpperCase();
      return /^[A-Z]+\d{1,2}$/.test(code) && (!plateDictionary.length || plateDictionary.includes(code));
    });
    const numberBoxes = boxes.filter((box) => /^\d{1,3}$/.test(box.text));
    const pairCandidates = plateBoxes.flatMap((plate, plateIndex) => {
      const [plateX, plateY, plateHeight = 0, plateWidth = 0] = plate.rotateRect;
      return numberBoxes
        .map((number, numberIndex) => {
          const [numberX, numberY, numberHeight = 0] = number.rotateRect;
          const dx = numberX - plateX;
          const dy = Math.abs(numberY - plateY);
          const maxDy = Math.max(22, plateHeight, numberHeight) * 1.4;
          const maxDx = Math.max(80, plateWidth * 2.5);
          return { plate, number, plateIndex, numberIndex, distance: Math.hypot(dx, dy), eligible: dx >= -12 && dx <= maxDx && dy <= maxDy };
        })
        .filter((candidate) => candidate.eligible);
    }).sort((left, right) => left.distance - right.distance);
    const usedPlates = new Set<number>();
    const usedNumbers = new Set<number>();
    for (const candidate of pairCandidates) {
      if (usedPlates.has(candidate.plateIndex) || usedNumbers.has(candidate.numberIndex)) continue;
      labels.add(`${candidate.plate.text.toUpperCase()}(${candidate.number.text})`);
      usedPlates.add(candidate.plateIndex);
      usedNumbers.add(candidate.numberIndex);
    }

    const parenthesized = raw.matchAll(/([A-Z]+\d+)\s*[（(]\s*(\d+)\s*[）)]/gi);
    for (const match of parenthesized) labels.add(`${match[1].toUpperCase()}(${match[2]})`);
    return { plateDictionary, labels: [...labels], boxes };
  }

  private emptyResult(model: string): OcrRecognitionResult {
    return { model, text: '', durationMs: 0, plateDictionary: [], labels: [], boxes: [] };
  }

  private mime(path: string): string {
    const extension = extname(path).toLowerCase();
    if (extension === '.png') return 'image/png';
    if (extension === '.webp') return 'image/webp';
    if (extension === '.heic') return 'image/heic';
    return 'image/jpeg';
  }
}
