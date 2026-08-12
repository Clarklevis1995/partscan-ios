import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { AnalysisOptions, ManualPageCaptureHint, OpenAIModel, PageInventory, PartsList, ReasoningEffort, UncertainItem } from '../domain';
import { buildImageVariants } from './image-variants';
import { fallbackSectionGroups, indexBatchSections, mergeBatchPartsLists, SectionGroup } from './parts-list-merger';

const partsSchema = {
  type: 'object', additionalProperties: false, required: ['sections', 'uncertainItems'],
  properties: {
    sections: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['unitId', 'name', 'multiplier', 'sourcePages', 'plates'],
      properties: {
        unitId: { type: 'string' }, name: { type: 'string' }, multiplier: { type: 'integer' }, sourcePages: { type: 'array', items: { type: 'integer' } },
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

const inventorySchema = {
  type: 'object', additionalProperties: false, required: ['pages'], properties: {
    pages: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['page', 'role', 'plateDictionary', 'assemblyUnits', 'labels'], properties: {
      page: { type: 'integer' }, role: { type: 'string', enum: ['plate_catalog', 'assembly_steps', 'other'] },
      plateDictionary: { type: 'array', items: { type: 'string' } },
      assemblyUnits: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['unitId', 'name', 'stepNumber', 'multiplier', 'startPage', 'startReadingOrder'], properties: {
        unitId: { type: 'string' }, name: { type: 'string' }, stepNumber: { type: 'string' }, multiplier: { type: 'integer' }, startPage: { type: 'integer' }, startReadingOrder: { type: 'integer' },
      } } },
      labels: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['plateCode', 'partNumber', 'parenthesized', 'unitId', 'readingOrder'], properties: {
        plateCode: { type: 'string' }, partNumber: { type: 'string' }, parenthesized: { type: 'boolean' }, unitId: { type: 'string' }, readingOrder: { type: 'integer' },
      } } },
    } } },
  },
} as const;

@Injectable()
export class OpenAIProvider {
  private readonly logger = new Logger(OpenAIProvider.name);
  constructor(private readonly config: ConfigService) {}

  async analyze(paths: string[], model: OpenAIModel, options: AnalysisOptions = { reasoningEffort: 'medium', vlmBatchSize: 3, multiScaleEnabled: true }, hints: ManualPageCaptureHint[] = [], inventory: PageInventory[] = []): Promise<PartsList> {
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
      const batchHints = batch.paths.map((_, pageIndex) => hints[batch.startPage + pageIndex - 1] ?? 'unknown');
      const references = paths.flatMap((path, pageIndex) => hints[pageIndex] === 'plate_catalog' && !batch.paths.includes(path) ? [{ path, page: pageIndex + 1 }] : []);
      results.push(await this.analyzeBatch(client, batch.paths, batchHints, references, batch.startPage, paths.length, model, options, batch.contextPath, batch.contextPage, inventory));
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

  async inventory(paths: string[], model: OpenAIModel, hints: ManualPageCaptureHint[] = [], batchSize = 3, reasoningEffort: ReasoningEffort = 'medium'): Promise<PageInventory[]> {
    if (this.config.get('QWEN_MOCK', 'true') === 'true') return paths.map((_, index) => ({ page: index + 1, role: hints[index] === 'plate_catalog' ? 'plate_catalog' : 'assembly_steps', plateDictionary: [], assemblyUnits: [], labels: [] }));
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) throw new ServiceUnavailableException('OPENAI_API_KEY is not configured');
    const client = new OpenAI({ apiKey, baseURL: this.config.get('OPENAI_BASE_URL', 'https://api.openai.com/v1') });
    const pages: PageInventory[] = [];
    let activeUnitContext = '无（这是第一批）';
    for (let offset = 0; offset < paths.length; offset += batchSize) {
      const slice = paths.slice(offset, offset + batchSize);
      const content: Array<Record<string, unknown>> = [];
      for (const [index, path] of slice.entries()) {
        const page = offset + index + 1;
        for (const variant of await buildImageVariants(path, true)) {
          content.push({ type: 'input_text', text: `全书第${page}页 · ${variant.label} · 用户提示=${hints[page - 1] ?? 'unknown'}` });
          content.push({ type: 'input_image', image_url: variant.dataUrl, detail: 'original' });
        }
      }
      content.push({ type: 'input_text', text: this.inventoryPrompt(offset + 1, offset + slice.length, activeUnitContext) });
      const startedAt = Date.now();
      this.logger.log(`OpenAI标签清点开始 model=${model} pages=${slice.length}`);
      const response = await client.responses.create({ model, store: false, reasoning: { effort: reasoningEffort }, input: [{ role: 'user', content: content as never }],
        text: { verbosity: 'low', format: { type: 'json_schema', name: 'label_inventory', strict: true, schema: inventorySchema } } });
      if (!response.output_text) throw new ServiceUnavailableException('OpenAI inventory returned an empty response');
      const parsed = JSON.parse(response.output_text) as { pages: PageInventory[] };
      pages.push(...parsed.pages);
      const lastUnit = parsed.pages.flatMap((page) => page.assemblyUnits).at(-1);
      if (lastUnit) activeUnitContext = JSON.stringify(lastUnit);
      this.logger.log(`OpenAI标签清点完成 model=${model} pages=${slice.length} labels=${parsed.pages.reduce((sum, page) => sum + page.labels.length, 0)} durationMs=${Date.now() - startedAt}`);
    }
    return pages.sort((left, right) => left.page - right.page);
  }

  private async analyzeBatch(client: OpenAI, paths: string[], hints: ManualPageCaptureHint[], plateReferences: Array<{ path: string; page: number }>, startPage: number, totalPages: number, model: OpenAIModel, options: AnalysisOptions, contextPath?: string, contextPage?: number, inventory: PageInventory[] = []): Promise<PartsList> {
    const content: Array<Record<string, unknown>> = [];
    for (const reference of plateReferences) {
      content.push({ type: 'input_text', text: `用户标记的候选板件参考页（全书第${reference.page}页）。请根据画面自行复核；仅在视觉上确为板件总览时建立字典，不得据此计件。` });
      for (const variant of await buildImageVariants(reference.path, false)) content.push({ type: 'input_image', image_url: variant.dataUrl, detail: 'original' });
    }
    if (contextPath && contextPage) {
      content.push({ type: 'input_text', text: `跨批上下文页（全书第${contextPage}页），只用于继承拼装单元和板件字典，不得重复计件。` });
      for (const variant of await buildImageVariants(contextPath, false)) content.push({ type: 'input_image', image_url: variant.dataUrl, detail: 'original' });
    }
    for (const [index, path] of paths.entries()) {
      const page = startPage + index;
      for (const variant of await buildImageVariants(path, options.multiScaleEnabled)) {
        content.push({ type: 'input_text', text: `说明书第${page}页 · ${variant.label} · 用户拍摄提示=${hints[index] ?? 'unknown'}（弱提示，必须根据画面复核）` });
        content.push({ type: 'input_image', image_url: variant.dataUrl, detail: 'original' });
      }
    }
    content.push({ type: 'input_text', text: this.prompt(startPage, startPage + paths.length - 1, totalPages, contextPage, inventory) });
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
      id, unitId: section.unitId ?? '', name: section.name, sourcePages: section.sourcePages ?? [],
      labels: section.plates.flatMap((plate) => plate.parts.map((part) => `${plate.code}(${part.number})`)),
    }));
    const response = await client.responses.create({
      model, store: false, reasoning: { effort: reasoningEffort },
      instructions: '只判断不同批次的 section 是否属于同一装配单元。不同unitId绝对不得合并，不得新增、删除或改写零件。',
      input: `优先按unitId归组；只有unitId完全相同才允许合并。结合名称、相邻页码和标签集合谨慎归组。每个ID必须且只能出现一次：${JSON.stringify(descriptors)}`,
      text: { verbosity: 'low', format: { type: 'json_schema', name: 'section_groups', strict: true, schema: groupingSchema } },
    });
    const parsed = JSON.parse(response.output_text) as { groups: SectionGroup[] };
    return parsed.groups;
  }

  private prompt(startPage: number, endPage: number, totalPages: number, contextPage?: number, inventory: PageInventory[] = []): string {
    const inventoryContext = inventory.length ? `\n独立标签清点结果：${JSON.stringify(inventory.filter((page) => page.page >= startPage && page.page <= endPage))}。它只作为完整性线索，不代表所有标签必须计件；但上下成组的不同板件标签不得因零件号相同而省略。` : '';
    return `分析全书第${startPage}-${endPage}页（共${totalPages}页）。${contextPage ? `第${contextPage}页仅为上下文，不得重复计件。` : ''}
先按视觉内容独立判断每页属于 plate_catalog（板件/流道总览）、assembly_steps（带箭头或步骤的拼装流程）还是 other；用户拍摄提示只是弱提示，画面证据优先。
plate_catalog 只用于建立全书板件字典和校验前缀，绝不能把其中展示的全部零件计入取件表；只有 assembly_steps 可以产生条目，other 忽略。
严格服从独立标签清点中的assemblyUnits：每个section必须输出对应unitId、name和multiplier。页面按顺序、每页从上到下逐行且每行从左到右阅读；新黑底起点图块出现后立即结束前一单元，后续标签不得再归入前一部位。不同unitId即使相邻或零件相似也不得合并。quantity只输出单套用量，不要乘x2；服务端会依据multiplier确定性乘算。
按部位→板件→零件输出。先读取每个拼装单元顶部的合法板件字典，plate.code必须来自字典。
普通字符和黑色圆圈必须分开读取：C1后圆圈1只能是C1(1)，不能从视觉连写得到C1(11)；C1后圆圈2只能是C1(2)，不能得到C1(12)。字典含A1但不含A11时，视觉连写A11必须解析为A1(1)；同理A114→A1(14)、G68→G6(8)、C38→C3(8)。只有A11明确出现在字典时才可作为板件编号。
完整页与三个高清局部是同页的不同尺度，不得重复计数。初次提取后从上到下复查每个装配框并补齐遗漏标签。无法确认则写入uncertainItems。
sourcePages必须使用全书页码；圆圈数字不是数量。零件附近有明确文字时原样作为name，否则可给简短推测描述。${inventoryContext}`;
  }

  private inventoryPrompt(startPage: number, endPage: number, activeUnitContext: string): string {
    return `清点全书第${startPage}-${endPage}页，并按页面顺序、每页从上到下逐行、每行从左到右建立阅读顺序。
上一批结束时的活动单元：${activeUnitContext}。若本批开头未出现新起点图块，必须沿用这个unitId；只有视觉上出现新起点图块才切换。
先识别每个部位开始的黑底起点图块：它通常包含步骤号、部位名称/英文名和可能的 x2。每个起点创建稳定unitId，例如 step-2-head；从该起点开始的后续格子都归属它，直到阅读顺序中出现下一个起点图块。跨页时延续最后一个unitId，除非出现新起点。x2记录为multiplier=2，不要立即重复标签。
视觉判断每页是 plate_catalog、assembly_steps 或 other。普通字符只属于plateCode，黑色圆圈内数字只属于partNumber：C1后圆圈1必须是C1(1)，禁止写成C1(11)；C1后圆圈2必须是C1(2)，禁止写成C1(12)。每个标签填写所属unitId和全页readingOrder。
上下排列且零件号相同但板件不同的标签必须分别保留，例如括号内 C2(12) 与下方 C1(12)。板件总览只填plateDictionary，不把其全部零件放入labels。`;
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
