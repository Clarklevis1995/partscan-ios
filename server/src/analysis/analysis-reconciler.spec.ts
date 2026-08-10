import { PartsList } from '../domain';
import { reconcileIndependentResults } from './analysis-reconciler';
import { OcrRecognitionResult } from './qwen-ocr.provider';

const vlmResult: PartsList = {
  sections: [{ name: '头部', plates: [{ code: 'A3', parts: [{ number: '23', quantity: 1 }] }] }],
  uncertainItems: [],
};

function ocr(labels: string[]): OcrRecognitionResult {
  return { model: 'qwen3.5-ocr', text: '', durationMs: 1, plateDictionary: [], labels, boxes: [] };
}

describe('independent OCR/VLM reconciliation', () => {
  it('does not change VLM parts when OCR agrees', () => {
    const result = reconcileIndependentResults(vlmResult, [ocr(['A3(23)'])]);
    expect(result.sections).toEqual(vlmResult.sections);
    expect(result.uncertainItems).toEqual([]);
  });

  it('flags OCR-only evidence without adding it to the parts list', () => {
    const result = reconcileIndependentResults(vlmResult, [ocr(['A1(23)']), ocr(['A1(23)'])]);
    expect(result.sections).toEqual(vlmResult.sections);
    expect(result.sections[0].plates).toHaveLength(1);
    expect(result.uncertainItems).toEqual([expect.objectContaining({
      description: 'OCR在第1、2页检测到 A1(23)，但VLM结果中没有该标签',
    })]);
  });
});
