import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'node:fs/promises';
import * as tencentcloud from 'tencentcloud-sdk-nodejs';
import { OcrRecognitionResult, OcrTextBox, QwenOcrProvider } from './qwen-ocr.provider';

export interface TencentTextDetection {
  text: string;
  confidence: number | null;
  polygon: Array<{ x: number; y: number }>;
  itemPolygon: { x: number; y: number; width: number; height: number } | null;
}

export interface TencentOcrRecognitionResult extends OcrRecognitionResult {
  angle: number | null;
  requestId: string | null;
  detections: TencentTextDetection[];
}

@Injectable()
export class TencentOcrProvider {
  private readonly logger = new Logger(TencentOcrProvider.name);
  private readonly concurrency = 3;

  constructor(
    private readonly config: ConfigService,
    private readonly evidenceParser: QwenOcrProvider,
  ) {}

  async recognizeImage(data: Buffer): Promise<TencentOcrRecognitionResult> {
    const base64 = data.toString('base64');
    if (Buffer.byteLength(base64, 'utf8') > 10 * 1024 * 1024) {
      throw new BadRequestException('腾讯云 OCR 要求图片 Base64 编码后不超过 10MB');
    }
    const secretId = this.config.get<string>('TENCENTCLOUD_SECRET_ID');
    const secretKey = this.config.get<string>('TENCENTCLOUD_SECRET_KEY');
    if (!secretId || !secretKey) {
      throw new ServiceUnavailableException('TENCENTCLOUD_SECRET_ID or TENCENTCLOUD_SECRET_KEY is not configured');
    }
    const client = new tencentcloud.ocr.v20181119.Client({
      credential: { secretId, secretKey },
      region: this.config.get('TENCENTCLOUD_REGION', 'ap-guangzhou'),
      profile: { httpProfile: { endpoint: 'ocr.tencentcloudapi.com' } },
    });
    const startedAt = Date.now();
    this.logger.log(`腾讯云OCR识别开始 api=GeneralAccurateOCR bytes=${data.length}`);
    const response = await client.GeneralAccurateOCR({
      ImageBase64: base64,
      ConfigID: 'OCR',
      WordsType: '2',
      EnableDetectText: true,
    });
    const detections: TencentTextDetection[] = (response.TextDetections ?? []).map((item) => ({
      text: item.DetectedText ?? '',
      confidence: item.Confidence ?? null,
      polygon: (item.Polygon ?? []).flatMap((point) =>
        typeof point.X === 'number' && typeof point.Y === 'number' ? [{ x: point.X, y: point.Y }] : [],
      ),
      itemPolygon: item.ItemPolygon ? {
        x: item.ItemPolygon.X,
        y: item.ItemPolygon.Y,
        width: item.ItemPolygon.Width,
        height: item.ItemPolygon.Height,
      } : null,
    })).filter((item) => item.text.length > 0);
    const boxes: OcrTextBox[] = detections.flatMap((item) => item.itemPolygon ? [{
      text: item.text,
      rotateRect: [item.itemPolygon.x, item.itemPolygon.y, item.itemPolygon.height, item.itemPolygon.width, 0],
    }] : []);
    const text = detections.map((item) => item.text).join('\n');
    const evidence = this.evidenceParser.extractEvidence(JSON.stringify(boxes.map((box) => ({
      text: box.text,
      rotate_rect: box.rotateRect,
    }))));
    const durationMs = Date.now() - startedAt;
    this.logger.log(`腾讯云OCR识别完成 requestId=${response.RequestId ?? '-'} lines=${detections.length} labels=${evidence.labels.length} durationMs=${durationMs}`);
    return {
      model: 'tencent-general-accurate-ocr',
      text,
      durationMs,
      ...evidence,
      angle: response.Angle ?? response.Angel ?? null,
      requestId: response.RequestId ?? null,
      detections,
    };
  }

  async recognizeStoredPages(paths: string[]): Promise<OcrRecognitionResult[]> {
    if (this.config.get('QWEN_MOCK', 'true') === 'true') {
      return paths.map(() => this.emptyResult());
    }
    const results: OcrRecognitionResult[] = paths.map(() => this.emptyResult());
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, paths.length) }, async () => {
      while (nextIndex < paths.length) {
        const index = nextIndex++;
        try {
          results[index] = await this.recognizeImage(await readFile(paths[index]));
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown Tencent OCR error';
          this.logger.warn(`腾讯云OCR页识别失败 page=${index + 1}: ${message}; VLM任务继续`);
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  private emptyResult(): OcrRecognitionResult {
    return { model: 'tencent-general-accurate-ocr', text: '', durationMs: 0, plateDictionary: [], labels: [], boxes: [] };
  }
}
