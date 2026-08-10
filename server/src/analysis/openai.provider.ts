import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { AnalysisOptions, OpenAIModel, PartsList, ReasoningEffort, UncertainItem } from '../domain';
import { buildImageVariants } from './image-variants';
import { fallbackSectionGroups, indexBatchSections, mergeBatchPartsLists, SectionGroup } from './parts-list-merger';

const partsSchema = {
  type: 'object', additionalProperties: false, required: ['sections', 'uncertainItems'],
  properties: {
    sections: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['name', 'sourcePages', 'plates'],
      properties: {
        name: { type: 'string' }, sourcePages: { type: 'array', items: { type: 'integer' } },
        plates: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['code', 'parts'],
          properties: { code: { type: 'string' }, parts: { type: 'array', items: {
            type: 'object', additionalProperties: false, required: ['number', 'name', 'quantity', 'sourcePages'],
            properties: {
              number: { type: 'string' }, name: { type: ['string', 'null'] }, quantity: { type: 'integer' },
              sourcePages: { type: 'array', items: { type: 'integer' } },
            },
          } } },
        } },
      },
    } },
    uncertainItems: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['description', 'suggestedAction'],
      properties: { description: { type: 'string' }, suggestedAction: { type: ['string', 'null'] } },
    } },
  },
} as const;

const groupingSchema = {
  type: 'object', additionalProperties: false, required: ['groups'], properties: {
    groups: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['name', 'sectionIds'],
      properties: { name: { type: 'string' }, sectionIds: { type: 'array', items: { type: 'string' } } },
    } },
  },
} as const;

@Injectable()
export class OpenAIProvider {
  private readonly logger = new Logger(OpenAIProvider.name);
  constructor(private readonly config: ConfigService) {}

  async analyze(paths: string[], model: OpenAIModel, options: AnalysisOptions = { reasoningEffort: 'medium', vlmBatchSize: 3, multiScaleEnabled: true }): Promise<PartsList> {
    if (this.config.get('QWEN_MOCK', 'true') === 'true') return this.mockResult();
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) throw new ServiceUnavailableException('OPENAI_API_KEY is not configured');
    const client = new OpenAI({ apiKey, baseURL: this.config.get('OPENAI_BASE_URL', 'https://api.openai.com/v1') });
    const batchSize = options.vlmBatchSize;
    const batches = Array.from({ length: Math.ceil(paths.length / batchSize) }, (_, index) => ({
      paths: paths.slice(index * batchSize, (index + 1) * batchSize), startPage: index * batchSize + 1,
      contextPath: index > 0 ? paths[index * batchSize - 1] : undefined, contextPage: index > 0 ? index * batchSize : undefined,
    }));
    this.logger.log(`OpenAI分批分析计划 model=${model} totalPages=${paths.length} batchSize=${batchSize} batches=${batches.length}`);
    const results: PartsList[] = [];
    for (const [index, batch] of batches.entries()) {
      this.logger.log(`OpenAI批次开始 batch=${index + 1}/${batches.length} pages=${batch.startPage}-${batch.startPage + batch.paths.length - 1}`);
      results.push(await this.analyzeBatch(client, batch.paths, batch.startPage, paths.length, model, options, batch.contextPath, batch.contextPage));
    }
    if (results.length === 1) return results[0];
    try {
      return this.validate(mergeBatchPartsLists(results, await this.summarizeSections(client, results, model, options.reasoningEffort)));
    } catch (error) {
      this.logger.warn(`OpenAI跨批汇总失败，使用同名部位确定性合并: ${error instanceof Error ? error.message : 'unknown'}`);
      const indexed = indexBatchSections(results);
      return this.validate(mergeBatchPartsLists(results, fallbackSectionGroups(indexed)));
    }
  }

  private async analyzeBatch(client: OpenAI, paths: string[], startPage: number, totalPages: number, model: OpenAIModel, options: AnalysisOptions, contextPath?: string, contextPage?: number): Promise<PartsList> {
    const content: Array<Record<string, unknown>> = [];
    if (contextPath && contextPage) {
      content.push({ type: 'input_text', text: `跨批上下文页（全书第${contextPage}页），只用于继承拼装单元和板件字典，不得重复计件。` });
      for (const variant of await buildImageVariants(contextPath, false)) content.push({ type: 'input_image', image_url: variant.dataUrl, detail: 'original' });
    }
    for (const [index, path] of paths.entries()) {
      const page = startPage + index;
      for (const variant of await buildImageVariants(path, options.multiScaleEnabled)) {
        content.push({ type: 'input_text', text: `说明书第${page}页 · ${variant.label}` });
        content.push({ type: 'input_image', image_url: variant.dataUrl, detail: 'original' });
      }
    }
    content.push({ type: 'input_text', text: this.prompt(startPage, startPage + paths.length - 1, totalPages, contextPage) });
    const startedAt = Date.now();
    const response = await client.responses.create({
      model, store: false, reasoning: { effort: options.reasoningEffort },
      instructions: '精确分析模型装配说明书。严格区分板件编号与圆圈中的零件数字，并输出符合 schema 的结果。',
      input: [{ role: 'user', content: content as never }],
      text: { verbosity: 'low', format: { type: 'json_schema', name: 'parts_list', strict: true, schema: partsSchema } },
    });
    if (!response.output_text) throw new ServiceUnavailableException('OpenAI returned an empty response');
    this.logger.log(`OpenAI批次完成 model=${model} pages=${paths.length} durationMs=${Date.now() - startedAt}`);
    return this.validate(this.parse(response.output_text));
  }

  private async summarizeSections(client: OpenAI, batches: PartsList[], model: OpenAIModel, reasoningEffort: ReasoningEffort): Promise<SectionGroup[]> {
    const descriptors = indexBatchSections(batches).map(({ id, section }) => ({
      id, name: section.name, sourcePages: section.sourcePages ?? [],
      labels: section.plates.flatMap((plate) => plate.parts.map((part) => `${plate.code}(${part.number})`)),
    }));
    const response = await client.responses.create({
      model, store: false, reasoning: { effort: reasoningEffort },
      instructions: '只判断不同批次的 section 是否属于同一模型部位。不得新增、删除或改写零件。',
      input: `结合名称、相邻页码和标签集合谨慎归组。每个ID必须且只能出现一次：${JSON.stringify(descriptors)}`,
      text: { verbosity: 'low', format: { type: 'json_schema', name: 'section_groups', strict: true, schema: groupingSchema } },
    });
    const parsed = JSON.parse(response.output_text) as { groups: SectionGroup[] };
    return parsed.groups;
  }

  private prompt(startPage: number, endPage: number, totalPages: number, contextPage?: number): string {
    return `分析全书第${startPage}-${endPage}页（共${totalPages}页）。${contextPage ? `第${contextPage}页仅为上下文，不得重复计件。` : ''}
按部位→板件→零件输出。先读取每个拼装单元顶部的合法板件字典，plate.code必须来自字典。
黑色圆圈数字是零件编号：字典含A1但不含A11时，视觉连写A11必须解析为A1(1)；同理A114→A1(14)、G68→G6(8)、C38→C3(8)。只有A11明确出现在字典时才可作为板件编号。
完整页与三个高清局部是同页的不同尺度，不得重复计数。初次提取后从上到下复查每个装配框并补齐遗漏标签。无法确认则写入uncertainItems。
sourcePages必须使用全书页码；圆圈数字不是数量。零件附近有明确文字时原样作为name，否则可给简短推测描述。`;
  }

  private parse(raw: string): PartsList {
    return JSON.parse(raw) as PartsList;
  }

  private validate(result: PartsList): PartsList {
    return {
      sections: result.sections.map((section) => ({ ...section, plates: section.plates.map((plate) => ({
        code: String(plate.code).toUpperCase(), parts: plate.parts.filter((part) => String(part.number).length > 0).map((part) => ({
          ...part, number: String(part.number), ...(part.name ? { name: part.name } : {}), quantity: Math.max(1, Math.min(99, Number(part.quantity) || 1)),
        })),
      })).filter((plate) => plate.code && plate.parts.length) })).filter((section) => section.plates.length),
      uncertainItems: result.uncertainItems.map((item): UncertainItem => ({ description: item.description, ...(item.suggestedAction ? { suggestedAction: item.suggestedAction } : {}) })),
    };
  }

  private mockResult(): PartsList {
    return { sections: [{ name: '头部', sourcePages: [1], plates: [{ code: 'A1', parts: [{ number: '1', name: '连接件', quantity: 1, sourcePages: [1] }] }] }], uncertainItems: [] };
  }
}
