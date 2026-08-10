import { PartsList, UncertainItem } from '../domain';
import { OcrRecognitionResult } from './qwen-ocr.provider';

function normalizeLabel(value: string): string {
  return value.toUpperCase().replace(/\s+/g, '');
}

/**
 * OCR is corroborating evidence only. It never adds, removes, or rewrites VLM
 * parts. Labels seen only by OCR are surfaced for a human to review.
 */
export function reconcileIndependentResults(vlm: PartsList, ocrPages: OcrRecognitionResult[]): PartsList {
  const vlmLabels = new Set(
    vlm.sections.flatMap((section) =>
      section.plates.flatMap((plate) => plate.parts.map((part) => normalizeLabel(`${plate.code}(${part.number})`))),
    ),
  );
  const ocrSources = new Map<string, { label: string; pages: number[] }>();
  ocrPages.forEach((page, pageIndex) => {
    page.labels.forEach((label) => {
      const key = normalizeLabel(label);
      const current = ocrSources.get(key) ?? { label: key, pages: [] };
      if (!current.pages.includes(pageIndex + 1)) current.pages.push(pageIndex + 1);
      ocrSources.set(key, current);
    });
  });

  const uncertainItems: UncertainItem[] = [...vlm.uncertainItems];
  const existing = new Set(uncertainItems.map((item) => item.description));
  for (const [key, evidence] of ocrSources) {
    if (vlmLabels.has(key)) continue;
    const description = `OCR在第${evidence.pages.join('、')}页检测到 ${evidence.label}，但VLM结果中没有该标签`;
    if (existing.has(description)) continue;
    uncertainItems.push({ description, suggestedAction: '请对照来源页原图确认；OCR不会自动修改取件表' });
    existing.add(description);
  }
  return { sections: vlm.sections, uncertainItems };
}
