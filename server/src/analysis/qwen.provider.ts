import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { AnalysisOptions, ManualPageCaptureHint, PageInventory, PartsList, QwenModel, UncertainItem } from '../domain';
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

  async analyze(paths: string[], model: QwenModel, options: AnalysisOptions = { reasoningEffort: 'medium', vlmBatchSize: 3, multiScaleEnabled: true }, hints: ManualPageCaptureHint[] = [], inventory: PageInventory[] = []): Promise<PartsList> {
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
      const batchHints = batch.paths.map((_, index) => hints[batch.startPage + index - 1] ?? 'unknown');
      const references = paths.flatMap((path, index) => hints[index] === 'plate_catalog' && !batch.paths.includes(path) ? [{ path, page: index + 1 }] : []);
      results.push(await this.analyzeBatch(key, batch.paths, batchHints, references, batch.startPage, paths.length, model, options.multiScaleEnabled, batch.contextPath, batch.contextPage, inventory));
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

  async inventory(paths: string[], model: QwenModel, hints: ManualPageCaptureHint[] = [], batchSize = 3): Promise<PageInventory[]> {
    if (this.config.get('QWEN_MOCK', 'true') === 'true') return paths.map((_, index) => ({ page: index + 1, role: hints[index] === 'plate_catalog' ? 'plate_catalog' : 'assembly_steps', plateDictionary: [], assemblyUnits: [], labels: [] }));
    const key = this.config.get<string>('DASHSCOPE_API_KEY');
    if (!key) throw new ServiceUnavailableException('DASHSCOPE_API_KEY is not configured');
    const pages: PageInventory[] = [];
    let activeUnitContext = '无（这是第一批）';
    for (let offset = 0; offset < paths.length; offset += batchSize) {
      const content: Array<Record<string, unknown>> = [];
      const slice = paths.slice(offset, offset + batchSize);
      for (const [index, path] of slice.entries()) {
        const page = offset + index + 1;
        for (const variant of await buildImageVariants(path, true)) {
          content.push({ type: 'text', text: `全书第${page}页 · ${variant.label} · 用户提示=${hints[page - 1] ?? 'unknown'}` });
          content.push({ type: 'image_url', image_url: { url: variant.dataUrl } });
        }
      }
      content.push({ type: 'text', text: this.inventoryPrompt(offset + 1, offset + slice.length, activeUnitContext) });
      const raw = await this.callRawVision(key, content, slice.length, model, '标签清点');
      const parsed = this.parseInventory(raw);
      pages.push(...parsed);
      const lastUnit = parsed.flatMap((page) => page.assemblyUnits).at(-1);
      if (lastUnit) activeUnitContext = JSON.stringify(lastUnit);
    }
    return pages.sort((left, right) => left.page - right.page);
  }

  private async analyzeBatch(
    key: string,
    paths: string[],
    hints: ManualPageCaptureHint[],
    plateReferences: Array<{ path: string; page: number }>,
    startPage: number,
    totalPages: number,
    model: QwenModel,
    multiScaleEnabled: boolean,
    contextPath?: string,
    contextPage?: number,
    inventory: PageInventory[] = [],
  ): Promise<PartsList> {
    const content: Array<Record<string, unknown>> = [];
    for (const reference of plateReferences) {
      const data = await readFile(reference.path);
      content.push({ type: 'text', text: `用户标记的候选板件参考页（全书第${reference.page}页）。请根据画面自行复核页面类型；仅在视觉上确为板件总览时用于建立字典，不得据此计件。` });
      content.push({ type: 'image_url', image_url: { url: `data:${this.mime(reference.path)};base64,${data.toString('base64')}` } });
    }
    if (contextPath && contextPage) {
      const data = await readFile(contextPath);
      content.push({ type: 'text', text: `跨批上下文页（全书第${contextPage}页）：仅用于判断拼装单元延续和继承板件字典，不要重复输出该页零件。` });
      content.push({ type: 'image_url', image_url: { url: `data:${this.mime(contextPath)};base64,${data.toString('base64')}` } });
    }
    for (const [index, path] of paths.entries()) {
      const page = startPage + index;
      const variants = await buildImageVariants(path, multiScaleEnabled);
      for (const variant of variants) {
        content.push({ type: 'text', text: `说明书第${page}页 · ${variant.label} · 用户拍摄提示=${hints[index] ?? 'unknown'}（提示不代表真实类型，必须视觉复核）：` });
        content.push({ type: 'image_url', image_url: { url: variant.dataUrl } });
      }
    }
    content.push({ type: 'text', text: this.prompt(startPage, startPage + paths.length - 1, totalPages, contextPage, inventory) });

    const result = await this.callVision(key, content, paths.length, model);
    return this.validate(result);
  }

  private async callRawVision(key: string, content: Array<Record<string, unknown>>, pageCount: number, requestedModel: QwenModel, purpose: string): Promise<string> {
    const baseURL = this.config.get('DASHSCOPE_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
    const model = this.resolveModel(requestedModel);
    const startedAt = Date.now();
    this.logger.log(`${purpose}开始 model=${model} pages=${pageCount}`);
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, ...this.inferenceOptions(requestedModel), response_format: { type: 'json_object' }, messages: [
        { role: 'system', content: '逐页检查模型说明书，完整转写所有零件标签并输出有效JSON。' }, { role: 'user', content },
      ] }),
    });
    const payload = await response.json() as QwenResponse;
    if (!response.ok) throw new ServiceUnavailableException(payload.error?.message ?? `${purpose} request failed`);
    const raw = payload.choices?.[0]?.message?.content;
    if (!raw) throw new ServiceUnavailableException(`${purpose} returned an empty response`);
    this.logger.log(`${purpose}完成 model=${model} pages=${pageCount} durationMs=${Date.now() - startedAt}`);
    return raw;
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
      unitId: section.unitId ?? '',
      name: section.name,
      sourcePages: section.sourcePages ?? [],
      labels: section.plates.flatMap((plate) => plate.parts.map((part) => `${plate.code}(${part.number})`)),
    }));
    const prompt = `你只负责判断分批提取结果中的模型部位是否属于同一装配单元，不得新增、删除或改写任何零件标签。不同unitId绝对不得合并。
优先按unitId归组；只有unitId完全相同才允许合并。再结合部位名称、相邻页码和标签集合。每个section id必须且只能出现一次。
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

  private prompt(startPage: number, endPage: number, totalPages: number, contextPage?: number, inventory: PageInventory[] = []): string {
    const inventoryContext = inventory.length ? `\n独立标签清点结果如下。它是完整性检查线索，不代表所有标签都必须计件；但同一装配步骤中上下排列、板件不同而零件号相同的标签不得当作重复项省略：${JSON.stringify(inventory.filter((page) => page.page >= startPage && page.page <= endPage))}` : '';
    return `你正在分析整本说明书第${startPage}-${endPage}页（全书共${totalPages}页）。${contextPage ? `前置的第${contextPage}页只是跨批上下文，不得重复统计其中的零件。` : ''}按图片顺序生成本批取件表：
1. 按模型部位分组，列出该部位使用的全部板件编号，以及每块板件中的零件数字编号。
2. A1、G6、C3 等是板件编号；紧邻的圆圈数字是零件编号，不是数量。
3. 同一板件、同一零件跨步骤重复出现时合并，并填写实际需要数量 quantity。
4. 如果说明书在某个零件附近提供了文字名称或说明，优先原样写入该零件的 name；没有明确文字时，可根据装配图给出简短中文推测描述。
5. sourcePages 必须使用图片标题中给出的全书页码，不要从 1 重新编号。无法确认的内容放入 uncertainItems。不要返回 confidence。
6. 只根据原始图片独立判断，不假设存在任何外部OCR结果。先对每页按视觉内容分类：plate_catalog（板件/流道总览）、assembly_steps（带箭头或步骤的拼装流程）、other。用户拍摄提示仅是弱提示，画面证据优先。
7. plate_catalog 页面只用于建立全书板件字典和校验板件前缀，绝不能把板件图上展示的全部零件当成已使用零件；只有 assembly_steps 页面可以产生取件表条目。other 页面忽略。
8. 严格服从独立清点中的assemblyUnits。每个section必须返回unitId、name、multiplier。按页序、每页从上到下逐行、每行从左到右读取；遇到新的黑底起点图块后立即结束前一单元。不同unitId不得合并。quantity只输出单套实际用量，不要乘x2；服务端会依据multiplier确定性乘算。
9. 本批内部连续页属于同一拼装单元时可以继承板件字典；出现新起点图块、标题或步骤编号时停止继承。
10. 同一页的完整页和高清局部不得重复计数。
11. 普通字符与黑色圆圈分开读取：C1后圆圈1只能输出C1(1)，禁止C1(11)；C1后圆圈2只能输出C1(2)，禁止C1(12)。若字典含A1但不含A11，则A11解析为A1(1)；A114→A1(14)，G68→G6(8)，C38→C3(8)。
12. 从上到下、同行从左到右复查所有装配框，无法确认时进入uncertainItems。
只返回 JSON：{"sections":[{"unitId":"step-2-head","name":"头部","multiplier":1,"sourcePages":[1],"plates":[{"code":"A1","parts":[{"number":"7","name":"连接件","quantity":1,"sourcePages":[1]}]}]}],"uncertainItems":[{"description":"无法确认的内容","suggestedAction":"建议补拍对应页面"}]}${inventoryContext}`;
  }

  private inventoryPrompt(startPage: number, endPage: number, activeUnitContext: string): string {
    return `清点全书第${startPage}-${endPage}页，按页面顺序、每页从上到下逐行、每行从左到右建立readingOrder。
上一批结束时的活动单元：${activeUnitContext}。若本批开头未出现新起点图块，必须沿用这个unitId；只有视觉上出现新起点图块才切换。
先识别部位开始的黑底起点图块，其中常包含步骤号、部位名称/英文名及x2。为每个起点创建稳定unitId；从它开始的格子均归属该unitId，直到出现下一个起点。跨页延续最后一个unitId。x2写入multiplier=2，不要在清点阶段复制标签。
判定每页role：plate_catalog、assembly_steps或other。逐个转写标签，普通字符只属于plateCode，黑色圆圈内数字只属于partNumber：C1后圆圈1必须输出C1(1)，禁止C1(11)；圆圈2必须输出C1(2)，禁止C1(12)。每个标签必须填写unitId和readingOrder。
上下排列、零件数字相同但板件不同的标签必须分别保留。板件图只填写plateDictionary，不把板件图全部数字写入labels。
只返回JSON：{"pages":[{"page":${startPage},"role":"assembly_steps","plateDictionary":["C1","C2"],"assemblyUnits":[{"unitId":"step-2-head","name":"头部","stepNumber":"2","multiplier":1,"startPage":${startPage},"startReadingOrder":1}],"labels":[{"plateCode":"C1","partNumber":"1","parenthesized":false,"unitId":"step-2-head","readingOrder":8}]}]}`;
  }

  private parseInventory(raw: string): PageInventory[] {
    const normalized = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const value = JSON.parse(normalized) as { pages?: unknown };
    if (!Array.isArray(value.pages)) throw new Error('Invalid label inventory schema');
    return value.pages.flatMap((entry): PageInventory[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const page = entry as { page?: unknown; role?: unknown; plateDictionary?: unknown; labels?: unknown };
      const pageNumber = Number(page.page);
      if (!Number.isInteger(pageNumber) || pageNumber < 1) return [];
      const role = page.role === 'plate_catalog' || page.role === 'other' ? page.role : 'assembly_steps';
      const labels = Array.isArray(page.labels) ? page.labels.flatMap((label): PageInventory['labels'] => {
        if (typeof label !== 'object' || label === null) return [];
        const item = label as { plateCode?: unknown; partNumber?: unknown; parenthesized?: unknown; unitId?: unknown; readingOrder?: unknown };
        if (typeof item.plateCode !== 'string' || !['string', 'number'].includes(typeof item.partNumber)) return [];
        return [{ plateCode: item.plateCode.toUpperCase(), partNumber: String(item.partNumber), parenthesized: item.parenthesized === true, unitId: typeof item.unitId === 'string' ? item.unitId : 'unassigned', readingOrder: Number(item.readingOrder) || 0 }];
      }) : [];
      const assemblyUnits = Array.isArray((page as { assemblyUnits?: unknown }).assemblyUnits) ? ((page as { assemblyUnits: unknown[] }).assemblyUnits).flatMap((unit): PageInventory['assemblyUnits'] => {
        if (typeof unit !== 'object' || unit === null) return [];
        const item = unit as Record<string, unknown>;
        if (typeof item.unitId !== 'string') return [];
        return [{ unitId: item.unitId, name: String(item.name ?? '未分类部位'), stepNumber: String(item.stepNumber ?? ''), multiplier: Math.max(1, Number(item.multiplier) || 1), startPage: Number(item.startPage) || pageNumber, startReadingOrder: Number(item.startReadingOrder) || 1 }];
      }) : [];
      return [{ page: pageNumber, role, plateDictionary: Array.isArray(page.plateDictionary) ? page.plateDictionary.filter((code): code is string => typeof code === 'string').map((code) => code.toUpperCase()) : [], assemblyUnits, labels }];
    });
  }

  private parse(raw: string): PartsList {
    const normalized = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const value = JSON.parse(normalized) as { sections?: unknown; uncertainItems?: unknown };
    if (!Array.isArray(value.sections) || !Array.isArray(value.uncertainItems)) {
      throw new Error('Invalid Qwen result schema');
    }

    const sections = value.sections.map((entry) => {
      const section = entry as { unitId?: unknown; name?: unknown; multiplier?: unknown; sourcePages?: unknown; plates?: unknown };
      const plates = Array.isArray(section.plates) ? section.plates : [];
      return {
        ...(typeof section.unitId === 'string' ? { unitId: section.unitId } : {}),
        name: String(section.name ?? '未分类部位'),
        ...(Number.isInteger(Number(section.multiplier)) ? { multiplier: Math.max(1, Number(section.multiplier)) } : {}),
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
