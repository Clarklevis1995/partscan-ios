import { Injectable, Logger } from '@nestjs/common';
import { AnalysisModel, AnalysisOptions, ManualPageCaptureHint, OpenAIModel, PageInventory, PartsList, QwenModel } from '../domain';
import { OpenAIProvider } from './openai.provider';
import { QwenProvider } from './qwen.provider';
import { ResultValidatorService, ValidationReport } from './result-validator.service';

export type AgentProgress = (progress: number, message: string, stage: 'inventory' | 'extracting' | 'validating' | 'reviewing') => void;

export interface ControlledAnalysisResult {
  partsList: PartsList;
  inventory: PageInventory[];
  validation: ValidationReport;
  reviewed: boolean;
}

@Injectable()
export class ControlledAnalysisAgentService {
  private readonly logger = new Logger(ControlledAnalysisAgentService.name);
  constructor(
    private readonly qwen: QwenProvider,
    private readonly openai: OpenAIProvider,
    private readonly validator: ResultValidatorService,
  ) {}

  async run(paths: string[], hints: ManualPageCaptureHint[], model: AnalysisModel, options: AnalysisOptions, progress: AgentProgress): Promise<ControlledAnalysisResult> {
    progress(18, '正在分类页面并清点零件标签', 'inventory');
    const inventory = await this.inventory(paths, hints, model, options);
    const roles = inventory.reduce<Record<string, number>>((counts, page) => ({ ...counts, [page.role]: (counts[page.role] ?? 0) + 1 }), {});
    const labelCount = inventory.reduce((sum, page) => sum + page.labels.length, 0);
    const dictionary = [...new Set(inventory.flatMap((page) => page.plateDictionary))];
    const units = inventory.flatMap((page) => page.assemblyUnits).filter((unit, index, all) => all.findIndex((candidate) => candidate.unitId === unit.unitId) === index);
    this.logger.log(`节点完成 stage=inventory pages=${inventory.length} roles=${JSON.stringify(roles)} units=${JSON.stringify(units.map((unit) => ({ id: unit.unitId, name: unit.name, step: unit.stepNumber, multiplier: unit.multiplier })))} labels=${labelCount} plateDictionary=${JSON.stringify(dictionary)}`);

    progress(38, '正在理解拼装流程并生成初步取件表', 'extracting');
    const initial = this.applyAssemblyPlan(await this.analyze(paths, hints, model, options, inventory), inventory);
    this.logger.log(`节点完成 stage=extracting ${this.summary(initial)}`);

    progress(66, '正在检查遗漏与板件编号冲突', 'validating');
    const initialReport = this.validator.validate(initial, inventory);
    this.logger.log(`节点完成 stage=validating issues=${initialReport.issues.length} missing=${initialReport.missingLabels.length} invalidPlate=${initialReport.invalidPlateLabels.length}`);
    if (!initialReport.issues.length) return { partsList: initial, inventory, validation: initialReport, reviewed: false };

    progress(76, `正在复核 ${initialReport.issues.length} 个可疑标签`, 'reviewing');
    this.logger.warn(`触发受控复核 attempt=1/1 issues=${initialReport.issues.length}`);
    const reviewed = this.applyAssemblyPlan(await this.analyze(paths, hints, model, options, inventory), inventory);
    const reviewedReport = this.validator.validate(reviewed, inventory);
    const useReviewed = reviewedReport.issues.length <= initialReport.issues.length;
    const chosen = useReviewed ? reviewed : initial;
    const chosenReport = useReviewed ? reviewedReport : initialReport;
    this.logger.log(`节点完成 stage=reviewing accepted=${useReviewed} beforeIssues=${initialReport.issues.length} afterIssues=${reviewedReport.issues.length} ${this.summary(chosen)}`);
    return { partsList: this.validator.appendUnresolved(chosen, chosenReport), inventory, validation: chosenReport, reviewed: true };
  }

  private inventory(paths: string[], hints: ManualPageCaptureHint[], model: AnalysisModel, options: AnalysisOptions): Promise<PageInventory[]> {
    return this.isOpenAI(model)
      ? this.openai.inventory(paths, model, hints, options.vlmBatchSize, options.reasoningEffort)
      : this.qwen.inventory(paths, model as QwenModel, hints, options.vlmBatchSize);
  }

  private analyze(paths: string[], hints: ManualPageCaptureHint[], model: AnalysisModel, options: AnalysisOptions, inventory: PageInventory[] = []): Promise<PartsList> {
    return this.isOpenAI(model)
      ? this.openai.analyze(paths, model, options, hints, inventory)
      : this.qwen.analyze(paths, model as QwenModel, options, hints, inventory);
  }

  private isOpenAI(model: AnalysisModel): model is OpenAIModel { return model.startsWith('gpt-'); }
  private applyAssemblyPlan(result: PartsList, inventory: PageInventory[]): PartsList {
    const units = new Map(inventory.flatMap((page) => page.assemblyUnits).map((unit) => [unit.unitId, unit]));
    return {
      sections: result.sections.map((section) => {
        const unit = section.unitId ? units.get(section.unitId) : undefined;
        if (!unit) return section;
        return {
          ...section,
          name: unit.name,
          multiplier: unit.multiplier,
          plates: section.plates.map((plate) => ({ ...plate, parts: plate.parts.map((part) => ({
            ...part, quantity: Math.max(1, part.quantity) * unit.multiplier,
          })) })),
        };
      }),
      uncertainItems: result.uncertainItems,
    };
  }
  private summary(result: PartsList): string {
    const plates = result.sections.reduce((sum, section) => sum + section.plates.length, 0);
    const labels = result.sections.reduce((sum, section) => sum + section.plates.reduce((partSum, plate) => partSum + plate.parts.length, 0), 0);
    return `sections=${result.sections.length} plates=${plates} labels=${labels} uncertain=${result.uncertainItems.length}`;
  }
}
