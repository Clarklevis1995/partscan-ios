import { PageInventory, PartsList } from '../domain';
import { ResultValidatorService } from './result-validator.service';

describe('ResultValidatorService', () => {
  const inventory: PageInventory[] = [{
    page: 2, role: 'assembly_steps', plateDictionary: ['C1', 'C2'], assemblyUnits: [{ unitId: 'step-2-head', name: '头部', stepNumber: '2', multiplier: 1, startPage: 2, startReadingOrder: 1 }], labels: [
      { plateCode: 'C2', partNumber: '12', parenthesized: true, unitId: 'step-2-head', readingOrder: 1 },
      { plateCode: 'C1', partNumber: '12', parenthesized: false, unitId: 'step-2-head', readingOrder: 2 },
    ],
  }];

  it('detects a vertically grouped alternative label omitted by VLM', () => {
    const result: PartsList = { sections: [{ unitId: 'step-2-head', name: '头部', sourcePages: [2], plates: [{ code: 'C2', parts: [{ number: '12', quantity: 1, sourcePages: [2] }] }] }], uncertainItems: [] };
    const report = new ResultValidatorService().validate(result, inventory);
    expect(report.missingLabels).toEqual([{ label: 'C1(12)', page: 2, reason: 'missing_from_parts_list' }]);
  });

  it('accepts both labels when neither was dropped', () => {
    const result: PartsList = { sections: [{ unitId: 'step-2-head', name: '头部', sourcePages: [2], plates: [
      { code: 'C2', parts: [{ number: '12', quantity: 1, sourcePages: [2] }] },
      { code: 'C1', parts: [{ number: '12', quantity: 1, sourcePages: [2] }] },
    ] }], uncertainItems: [] };
    expect(new ResultValidatorService().validate(result, inventory).issues).toEqual([]);
  });

  it('detects when C1 circle 1 was merged into C1(11)', () => {
    const circleInventory: PageInventory[] = [{ ...inventory[0], labels: [{ plateCode: 'C1', partNumber: '1', parenthesized: false, unitId: 'step-2-head', readingOrder: 1 }] }];
    const result: PartsList = { sections: [{ unitId: 'step-2-head', name: '头部', sourcePages: [2], plates: [{ code: 'C1', parts: [{ number: '11', quantity: 1, sourcePages: [2] }] }] }], uncertainItems: [] };
    expect(new ResultValidatorService().validate(result, circleInventory).boundaryIssues).toContainEqual({ label: 'C1(11)', page: 2, reason: 'merged_circle_number' });
  });

  it('detects sections assigned outside a planned assembly unit', () => {
    const result: PartsList = { sections: [{ unitId: 'step-3-arms', name: '肩甲', sourcePages: [2], plates: [{ code: 'C1', parts: [{ number: '12', quantity: 1, sourcePages: [2] }] }] }], uncertainItems: [] };
    expect(new ResultValidatorService().validate(result, inventory).boundaryIssues).toContainEqual({ label: '肩甲', page: 2, reason: 'wrong_assembly_unit' });
  });
});
