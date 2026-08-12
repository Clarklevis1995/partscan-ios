import { Injectable, Logger } from '@nestjs/common';
import { PageInventory, PartsList, UncertainItem } from '../domain';

export interface ValidationIssue {
  label: string;
  page: number;
  reason: 'missing_from_parts_list' | 'invalid_plate_code' | 'wrong_assembly_unit' | 'merged_circle_number';
}

export interface ValidationReport {
  issues: ValidationIssue[];
  missingLabels: ValidationIssue[];
  invalidPlateLabels: ValidationIssue[];
  boundaryIssues: ValidationIssue[];
}

@Injectable()
export class ResultValidatorService {
  private readonly logger = new Logger(ResultValidatorService.name);

  validate(result: PartsList, inventory: PageInventory[]): ValidationReport {
    const extracted = new Set(result.sections.flatMap((section) =>
      section.plates.flatMap((plate) => plate.parts.map((part) => this.unitKey(section.unitId, plate.code, part.number))),
    ));
    const dictionary = new Set(inventory.flatMap((page) => page.plateDictionary.map((code) => code.toUpperCase())));
    const missing = inventory.flatMap((page) => page.role === 'assembly_steps'
      ? page.labels.flatMap((label): ValidationIssue[] => extracted.has(this.unitKey(label.unitId, label.plateCode, label.partNumber)) ? [] : [{
          label: `${label.plateCode.toUpperCase()}(${label.partNumber})`, page: page.page, reason: 'missing_from_parts_list',
        }])
      : []);
    const invalid = result.sections.flatMap((section) => section.plates.flatMap((plate) => {
      if (!dictionary.size || dictionary.has(plate.code.toUpperCase())) return [];
      const page = section.sourcePages?.[0] ?? plate.parts[0]?.sourcePages?.[0] ?? 1;
      return plate.parts.map((part): ValidationIssue => ({
        label: `${plate.code.toUpperCase()}(${part.number})`, page, reason: 'invalid_plate_code',
      }));
    }));
    const knownUnits = new Set(inventory.flatMap((page) => page.assemblyUnits.map((unit) => unit.unitId)));
    const boundary = result.sections.flatMap((section): ValidationIssue[] => !section.unitId || !knownUnits.has(section.unitId) ? [{
      label: section.name, page: section.sourcePages?.[0] ?? 1, reason: 'wrong_assembly_unit',
    }] : []);
    const inventoryByUnit = new Map<string, Set<string>>();
    inventory.flatMap((page) => page.labels).forEach((label) => {
      const labels = inventoryByUnit.get(label.unitId) ?? new Set<string>(); labels.add(this.key(label.plateCode, label.partNumber)); inventoryByUnit.set(label.unitId, labels);
    });
    const mergedCircle = result.sections.flatMap((section) => section.plates.flatMap((plate) => plate.parts.flatMap((part): ValidationIssue[] => {
      const expected = inventoryByUnit.get(section.unitId ?? '') ?? new Set<string>();
      if (expected.has(this.key(plate.code, part.number)) || part.number.length < 2) return [];
      const circleOnly = part.number.slice(-1);
      return expected.has(this.key(plate.code, circleOnly)) ? [{ label: `${plate.code}(${part.number})`, page: part.sourcePages?.[0] ?? section.sourcePages?.[0] ?? 1, reason: 'merged_circle_number' }] : [];
    })));
    const issues = this.unique([...missing, ...invalid, ...boundary, ...mergedCircle]);
    this.logger.log(`校验完成 inventoryLabels=${inventory.reduce((sum, page) => sum + page.labels.length, 0)} extractedLabels=${extracted.size} missing=${missing.length} invalidPlate=${invalid.length} boundary=${boundary.length} mergedCircle=${mergedCircle.length}`);
    if (issues.length) this.logger.warn(`待复核标签=${issues.slice(0, 30).map((issue) => `${issue.label}@p${issue.page}:${issue.reason}`).join(',')}`);
    return { issues, missingLabels: this.unique(missing), invalidPlateLabels: this.unique(invalid), boundaryIssues: this.unique([...boundary, ...mergedCircle]) };
  }

  appendUnresolved(result: PartsList, report: ValidationReport): PartsList {
    const existing = new Set(result.uncertainItems.map((item) => item.description));
    const additions: UncertainItem[] = report.issues.flatMap((issue) => {
      const description = issue.reason === 'missing_from_parts_list' ? `标签清点在第${issue.page}页发现 ${issue.label}，但复核后仍未能归入正确部位`
        : issue.reason === 'invalid_plate_code' ? `第${issue.page}页的 ${issue.label} 使用了不在板件字典中的板件编号`
        : issue.reason === 'merged_circle_number' ? `第${issue.page}页的 ${issue.label} 疑似把板件尾数与圆圈数字合并`
        : `第${issue.page}页的 ${issue.label} 未能匹配到明确的装配单元`;
      return existing.has(description) ? [] : [{ description, suggestedAction: '请对照来源页确认该标签及其替代关系' }];
    });
    return { sections: result.sections, uncertainItems: [...result.uncertainItems, ...additions] };
  }

  private key(plate: string, part: string): string { return `${plate.toUpperCase().replace(/\s+/g, '')}(${String(part).replace(/\s+/g, '')})`; }
  private unitKey(unitId: string | undefined, plate: string, part: string): string { return `${unitId ?? 'unassigned'}:${this.key(plate, part)}`; }
  private unique(issues: ValidationIssue[]): ValidationIssue[] {
    const seen = new Set<string>();
    return issues.filter((issue) => {
      const key = `${issue.label}:${issue.page}:${issue.reason}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
}
