import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { AnalysisOptions, PartsList, QwenModel, UncertainItem } from '../domain';
import { fallbackSectionGroups, indexBatchSections, mergeBatchPartsLists, SectionGroup } from './parts-list-merger';
import { buildImageVariants } from './image-variants';

interface QwenResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

@Injectable()
export class QwenProvider {
  private readonly logger = new Logger(QwenProvider.name);

  constructor(private readonly config: ConfigService) {}

  async analyze(paths: string[], model: QwenModel, options: AnalysisOptions = { reasoningEffort: 'medium', vlmBatchSize: 3, multiScaleEnabled: true }): Promise<PartsList> {
    if (this.config.get('QWEN_MOCK', 'true') === 'true') return this.validate(this.mockResult());
    const key = this.config.get<string>('DASHSCOPE_API_KEY');
    if (!key) throw new ServiceUnavailableException('DASHSCOPE_API_KEY is not configured');
    const batchSize = options.vlmBatchSize;
    const batches = Array.from({ length: Math.ceil(paths.length / batchSize) }, (_, index) => ({
      paths: paths.slice(index * batchSize, (index + 1) * batchSize),
      startPage: index * batchSize + 1,
      contextPath: index > 0 ? paths[index * batchSize - 1] : undefined,
      contextPage: index > 0 ? index * batchSize : undefined,
    }));
    this.logger.log(`千问分批分析计划 model=${model} totalPages=${paths.length} batchSize=${batchSize} batches=${batches.length}`);
    const results: PartsList[] = [];
    for (const [batchIndex, batch] of batches.entries()) {
      this.logger.log(`千问批次开始 batch=${batchIndex + 1}/${batches.length} pages=${batch.startPage}-${batch.startPage + batch.paths.length - 1}`);
      results.push(await this.analyzeBatch(key, batch.paths, batch.startPage, paths.length, model, options.multiScaleEnabled, batch.contextPath, batch.contextPage));
    }
    if (results.length === 1) return results[0];
    try {
      const groups = await this.summarizeSections(key, results, model);
      return this.validate(mergeBatchPartsLists(results, groups));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown summary error';
      this.logger.warn(`千问跨批部位汇总失败，使用同名部位确定性合并: ${message}`);
      const indexed = indexBatchSections(results);
      return this.validate(mergeBatchPartsLists(results, fallbackSectionGroups(indexed)));
    }
  }

  private async analyzeBatch(
    key: string,
    paths: string[],
    startPage: number,
    totalPages: number,
    model: QwenModel,
    multiScaleEnabled: boolean,
    contextPath?: string,
    contextPage?: number,
  ): Promise<PartsList> {
    const content: Array<Record<string, unknown>> = [];
    if (contextPath && contextPage) {
      const data = await readFile(contextPath);
      content.push({ type: 'text', text: `跨批上下文页（全书第${contextPage}页）：仅用于判断拼装单元延续和继承板件字典，不要重复输出该页零件。` });
      content.push({ type: 'image_url', image_url: { url: `data:${this.mime(contextPath)};base64,${data.toString('base64')}` } });
    }
    for (const [index, path] of paths.entries()) {
      const page = startPage + index;
      const variants = await buildImageVariants(path, multiScaleEnabled);
      for (const variant of variants) {
        content.push({ type: 'text', text: `说明书第${page}页 · ${variant.label}：` });
        content.push({ type: 'image_url', image_url: { url: variant.dataUrl } });
      }
    }
    content.push({ type: 'text', text: this.prompt(startPage, startPage + paths.length - 1, totalPages, contextPage) });

    const result = await this.callVision(key, content, paths.length, model);
    return this.validate(result);
  }

  private async callVision(key: string, content: Array<Record<string, unknown>>, pageCount: number, requestedModel: QwenModel): Promise<PartsList> {
    const baseURL = this.config.get('DASHSCOPE_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
    const model = this.resolveModel(requestedModel);
    const startedAt = Date.now();
    this.logger.log(`千问单次分析开始 model=${model} pages=${pageCount}`);

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        ...this.inferenceOptions(requestedModel),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '分析模型装配说明书并输出有效 JSON。' },
          { role: 'user', content },
        ],
      }),
    });

    const payload = await response.json() as QwenResponse;
    if (!response.ok) {
      const message = payload.error?.message ?? 'Qwen request failed';
      this.logger.error(`千问单次分析失败 model=${model} status=${response.status} durationMs=${Date.now() - startedAt}: ${message}`);
      throw new ServiceUnavailableException(message);
    }
    const raw = payload.choices?.[0]?.message?.content;
    if (!raw) throw new ServiceUnavailableException('Qwen returned an empty response');
    this.logger.log(`千问单次分析完成 model=${model} pages=${pageCount} durationMs=${Date.now() - startedAt}`);
    if (this.config.get('NODE_ENV', 'development') !== 'production') {
      this.logger.debug(`[Qwen] raw JSON: ${raw.slice(0, 12_000)}`);
    }
    return this.parse(raw);
  }

  private async summarizeSections(key: string, batches: PartsList[], requestedModel: QwenModel): Promise<SectionGroup[]> {
    const indexed = indexBatchSections(batches);
    const descriptors = indexed.map(({ id, section }) => ({
      id,
      name: section.name,
      sourcePages: section.sourcePages ?? [],
      labels: section.plates.flatMap((plate) => plate.parts.map((part) => `${plate.code}(${part.number})`)),
    }));
    const prompt = `你只负责判断分批提取结果中的模型部位是否属于同一部位，不得新增、删除或改写任何零件标签。
结合部位名称、相邻页码和标签集合，将语义相同的部位归为一组。名称相似但明显属于不同组件时不要合并。每个 section id 必须且只能出现一次。
只返回 JSON：{"groups":[{"name":"头部","sectionIds":["b1s1","b2s1"]}]}
待归组数据：${JSON.stringify(descriptors)}`;
    const raw = await this.callText(key, prompt, requestedModel);
    const normalized = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const value = JSON.parse(normalized) as { groups?: unknown };
    if (!Array.isArray(value.groups)) throw new Error('Invalid section grouping schema');
    return value.groups.flatMap((entry): SectionGroup[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const group = entry as { name?: unknown; sectionIds?: unknown };
      if (typeof group.name !== 'string' || !Array.isArray(group.sectionIds)) return [];
      return [{ name: group.name, sectionIds: group.sectionIds.filter((id): id is string => typeof id === 'string') }];
    });
  }

  private async callText(key: string, prompt: string, requestedModel: QwenModel): Promise<string> {
    const baseURL = this.config.get('DASHSCOPE_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
    const model = this.resolveModel(requestedModel);
    const startedAt = Date.now();
    this.logger.log(`千问跨批部位汇总开始 model=${model}`);
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        ...this.inferenceOptions(requestedModel),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '对模型说明书分批提取结果中的部位进行谨慎归组，并输出有效 JSON。' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    const payload = await response.json() as QwenResponse;
    if (!response.ok) throw new Error(payload.error?.message ?? `Qwen summary request failed (${response.status})`);
    const raw = payload.choices?.[0]?.message?.content;
    if (!raw) throw new Error('Qwen summary returned an empty response');
    this.logger.log(`千问跨批部位汇总完成 model=${model} durationMs=${Date.now() - startedAt}`);
    return raw;
  }

  private resolveModel(requestedModel: QwenModel): string {
    switch (requestedModel) {
      case 'qwen3.8-max':
        return this.config.get('QWEN_38_MAX_MODEL', 'qwen3.8-max-preview');
      case 'qwen3.7-max':
        // The qwen3.7-max alias currently points to the text-only 2026-05-20
        // snapshot. Pin the 2026-06-08 snapshot because this pipeline sends images.
        return this.config.get('QWEN_MAX_MODEL', 'qwen3.7-max-2026-06-08');
      case 'qwen3.7-plus':
        return this.config.get('QWEN_PLUS_MODEL', 'qwen3.7-plus');
      case 'qwen3.7-flash':
        return this.config.get('QWEN_FLASH_MODEL', 'qwen3.7-flash');
    }
  }

  private inferenceOptions(requestedModel: QwenModel): Record<string, unknown> {
    if (requestedModel !== 'qwen3.8-max') return { temperature: 0, enable_thinking: false };
    const configured = this.config.get<string>('QWEN_38_REASONING_EFFORT', 'medium');
    const reasoningEffort = ['low', 'medium', 'xhigh'].includes(configured) ? configured : 'medium';
    return { temperature: 0.6, enable_thinking: true, reasoning_effort: reasoningEffort };
  }

  private prompt(startPage: number, endPage: number, totalPages: number, contextPage?: number): string {
    return `你正在分析整本说明书第${startPage}-${endPage}页（全书共${totalPages}页）。${contextPage ? `前置的第${contextPage}页只是跨批上下文，不得重复统计其中的零件。` : ''}按图片顺序生成本批取件表：
1. 按模型部位分组，列出该部位使用的全部板件编号，以及每块板件中的零件数字编号。
2. A1、G6、C3 等是板件编号；紧邻的圆圈数字是零件编号，不是数量。
3. 同一板件、同一零件跨步骤重复出现时合并，并填写实际需要数量 quantity。
4. 如果说明书在某个零件附近提供了文字名称或说明，优先原样写入该零件的 name；没有明确文字时，可根据装配图给出简短中文推测描述。
5. sourcePages 必须使用图片标题中给出的全书页码，不要从 1 重新编号。无法确认的内容放入 uncertainItems。不要返回 confidence。
6. 只根据原始图片独立判断，不假设存在任何外部OCR结果。先从每页顶部或拼装单元开头读取合法板件字典。
7. 本批内部连续页属于同一拼装单元时可以继承板件字典；出现新标题、新板件列表或步骤重新编号时停止继承。不得猜测未提供的其他批次内容。
8. 同一页的“完整页”和“高清局部”是同一张页面的不同尺度视图，只用于交叉核对，不得重复计算数量。
9. 先读取当前拼装单元的合法板件字典。plate.code 必须来自该字典；只有 A11 明确出现在字典中时才可输出 A11。
10. 对疑似连写字符执行合法板件前缀拆分：若字典含 A1 但不含 A11，则 A11 必须解析为 A1(1)；A114→A1(14)，G68→G6(8)，C38→C3(8)。黑色圆圈中的数字是零件编号。
11. 初次提取后，按每页从上到下重新检查所有装配框，补齐遗漏的“板件编号 + 圆圈数字”；无法区分时放入 uncertainItems，不要猜测。
只返回 JSON：{"sections":[{"name":"头部","sourcePages":[1],"plates":[{"code":"A1","parts":[{"number":"7","name":"连接件","quantity":1,"sourcePages":[1]}]}]}],"uncertainItems":[{"description":"无法确认的内容","suggestedAction":"建议补拍对应页面"}]}`;
  }

  private parse(raw: string): PartsList {
    const normalized = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const value = JSON.parse(normalized) as { sections?: unknown; uncertainItems?: unknown };
    if (!Array.isArray(value.sections) || !Array.isArray(value.uncertainItems)) {
      throw new Error('Invalid Qwen result schema');
    }

    const sections = value.sections.map((entry) => {
      const section = entry as { name?: unknown; sourcePages?: unknown; plates?: unknown };
      const plates = Array.isArray(section.plates) ? section.plates : [];
      return {
        name: String(section.name ?? '未分类部位'),
        ...(Array.isArray(section.sourcePages) ? { sourcePages: this.pages(section.sourcePages) } : {}),
        plates: plates.map((plateEntry) => {
          const plate = plateEntry as { code?: unknown; parts?: unknown };
          const parts = Array.isArray(plate.parts) ? plate.parts : [];
          return {
            code: String(plate.code ?? '').toUpperCase(),
            parts: parts.map((partEntry) => {
              const part = partEntry as { number?: unknown; name?: unknown; quantity?: unknown; sourcePages?: unknown };
              return {
                number: String(part.number ?? ''),
                ...(typeof part.name === 'string' && part.name.trim() ? { name: part.name.trim() } : {}),
                quantity: Number(part.quantity) || 1,
                ...(Array.isArray(part.sourcePages) ? { sourcePages: this.pages(part.sourcePages) } : {}),
              };
            }),
          };
        }),
      };
    });

    return {
      sections,
      uncertainItems: value.uncertainItems.map((item) => this.normalizeUncertainItem(item)),
    };
  }

  private validate(result: PartsList): PartsList {
    const sections = result.sections.map((section) => ({
      ...section,
      plates: section.plates
        .filter((plate) => plate.code.length > 0)
        .map((plate) => ({
          ...plate,
          parts: plate.parts
            .filter((part) => part.number.length > 0)
            .map((part) => ({ ...part, quantity: Math.max(1, Math.min(99, part.quantity)) })),
        }))
        .filter((plate) => plate.parts.length > 0),
    })).filter((section) => section.plates.length > 0);
    return { sections, uncertainItems: result.uncertainItems };
  }

  private normalizeUncertainItem(item: unknown): UncertainItem {
    if (typeof item === 'string') return { description: item };
    if (typeof item === 'object' && item !== null && typeof (item as { description?: unknown }).description === 'string') {
      const value = item as { description: string; suggestedAction?: unknown };
      return {
        description: value.description,
        ...(typeof value.suggestedAction === 'string' ? { suggestedAction: value.suggestedAction } : {}),
      };
    }
    throw new Error('Invalid uncertainItems entry');
  }

  private pages(values: unknown[]): number[] {
    return [...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value > 0))];
  }

  private mime(path: string): string {
    const extension = extname(path).toLowerCase();
    if (extension === '.png') return 'image/png';
    if (extension === '.webp') return 'image/webp';
    if (extension === '.heic') return 'image/heic';
    return 'image/jpeg';
  }

  private mockResult(): PartsList {
    return {
      sections: [{
        name: '头部',
        sourcePages: [1],
        plates: [{ code: 'A1', parts: [
          { number: '7', name: '连接件', quantity: 1, sourcePages: [1] },
          { number: '13', name: '说明书文字描述', quantity: 1, sourcePages: [1] },
        ] }],
      }],
      uncertainItems: [],
    };
  }
}
