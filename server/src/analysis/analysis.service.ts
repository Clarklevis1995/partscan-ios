import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnalysisModel, AnalysisOptions, AnalysisRecord } from '../domain';
import { ProductsRepository } from '../products/products.repository';
import { AnalysisRepository } from './analysis.repository';
import { reconcileIndependentResults } from './analysis-reconciler';
import { QwenOcrProvider } from './qwen-ocr.provider';
import { TencentOcrProvider } from './tencent-ocr.provider';
import { ControlledAnalysisAgentService } from './controlled-analysis-agent.service';

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);
  constructor(
    private readonly analyses: AnalysisRepository,
    private readonly products: ProductsRepository,
    private readonly agent: ControlledAnalysisAgentService,
    private readonly ocr: QwenOcrProvider,
    private readonly tencentOcr: TencentOcrProvider,
    private readonly config: ConfigService,
  ) {}

  start(productId: string, model: AnalysisModel, useOcr: boolean, options: AnalysisOptions): AnalysisRecord {
    const product = this.products.get(productId);
    if (!product.manualPagePaths.length) throw new BadRequestException('Upload manual pages before starting analysis');
    if (product.activeAnalysisId) {
      const current = this.analyses.get(product.activeAnalysisId);
      if (!['completed', 'failed'].includes(current.status)) throw new ConflictException('An analysis is already running for this product');
    }
    const job = this.analyses.create(productId, model, useOcr, options);
    this.products.setAnalysis(productId, job.id);
    this.logger.log(`分析任务已创建 analysisId=${job.id} productId=${productId} model=${model} useOcr=${useOcr} batchSize=${options.vlmBatchSize} multiScale=${options.multiScaleEnabled} reasoning=${options.reasoningEffort}`);
    setImmediate(() => void this.run(job.id));
    return job;
  }

  get(id: string) { return this.analyses.get(id); }

  getPartsList(productId: string) {
    const product = this.products.get(productId);
    if (!product.partsList) throw new ConflictException('The parts list is not ready');
    return { productId, analysisId: product.activeAnalysisId, ...product.partsList };
  }

  models() {
    return [
      { id: 'qwen3.7-flash', title: 'Qwen 3.7 Flash', recommended: true, usage: '速度优先，适合大多数说明书' },
      { id: 'qwen3.7-plus', title: 'Qwen 3.7 Plus', recommended: false, usage: '视觉能力与成本更均衡' },
      { id: 'qwen3.7-max', title: 'Qwen 3.7 Max', recommended: false, usage: '复杂图纸优先，耗时和成本更高' },
      { id: 'qwen3.8-max', title: 'Qwen 3.8 Max（预览）', recommended: false, usage: 'Token Plan 专属，视觉精度优先且必须开启思考模式' },
      { id: 'gpt-5.6-sol', title: 'GPT-5.6 Sol', recommended: false, usage: 'OpenAI 旗舰视觉模型，精度优先' },
      { id: 'gpt-5.6-terra', title: 'GPT-5.6 Terra', recommended: false, usage: 'OpenAI 视觉能力与成本均衡' },
      { id: 'gpt-5.6-luna', title: 'GPT-5.6 Luna', recommended: false, usage: 'OpenAI 高吞吐低成本视觉模型' },
    ];
  }

  private async run(jobId: string) {
    const job = this.analyses.get(jobId);
    const startedAt = Date.now();
    try {
      this.analyses.update(jobId, 'analyzing', 10, '正在准备说明书页面', undefined, 'preparing');
      const product = this.products.get(job.productId);
      this.logger.log(`开始分析 analysisId=${jobId} productId=${job.productId} pages=${product.manualPagePaths.length} model=${job.model} useOcr=${job.useOcr} options=${JSON.stringify(job.options)}`);
      this.logger.log(`节点完成 stage=preparing paths=${product.manualPagePaths.length} hints=${JSON.stringify(product.manualPageHints)}`);
      const ocrProvider = this.config.get('OCR_PROVIDER', 'qwen') === 'tencent' ? this.tencentOcr : this.ocr;
      const agentResult = await this.agent.run(product.manualPagePaths, product.manualPageHints, job.model, job.options, (progress, message, stage) => {
        this.analyses.update(jobId, 'analyzing', progress, message, undefined, stage);
      });
      const vlmResult = agentResult.partsList;
      this.analyses.update(jobId, 'analyzing', 86, job.useOcr ? '正在对照 OCR 独立证据' : '正在合并分析结果', undefined, 'reconciling');
      const ocrResult = job.useOcr ? await ocrProvider.recognizeStoredPages(product.manualPagePaths) : [];
      const result = job.useOcr ? reconcileIndependentResults(vlmResult, ocrResult) : vlmResult;
      if (job.useOcr) {
        const ocrLabels = ocrResult.reduce((sum, page) => sum + page.labels.length, 0);
        this.logger.log(`独立结果协调完成 analysisId=${jobId} ocrLabels=${ocrLabels} addedReviewItems=${result.uncertainItems.length - vlmResult.uncertainItems.length}`);
      }
      this.logger.log(`节点完成 stage=reconciling ocrPages=${ocrResult.length} resultUncertain=${result.uncertainItems.length}`);
      this.analyses.update(jobId, 'generating', 94, '正在生成最终取件表', undefined, 'generating');
      this.products.setPartsList(job.productId, result);
      this.analyses.update(jobId, 'completed', 100, '取件表已生成', undefined, 'completed');
      const plates = result.sections.reduce((sum, section) => sum + section.plates.length, 0);
      const parts = result.sections.reduce(
        (sum, section) => sum + section.plates.reduce((plateSum, plate) => plateSum + plate.parts.length, 0),
        0,
      );
      this.logger.log(`分析完成 analysisId=${jobId} durationMs=${Date.now() - startedAt} sections=${result.sections.length} plates=${plates} parts=${parts} uncertain=${result.uncertainItems.length} manualCacheRetained=true`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown analysis error';
      this.analyses.update(jobId, 'failed', 100, '分析失败，已保留上传图片以便重试', message, 'failed');
      this.logger.error(`分析失败 analysisId=${jobId} durationMs=${Date.now() - startedAt}: ${message}`, error instanceof Error ? error.stack : undefined);
    }
  }
}
