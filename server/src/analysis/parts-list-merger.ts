import { AssemblySection, PartItem, PartsList, UncertainItem } from '../domain';

export interface SectionGroup { name: string; sectionIds: string[] }

export interface IndexedSection { id: string; section: AssemblySection }

export function indexBatchSections(batches: PartsList[]): IndexedSection[] {
  return batches.flatMap((batch, batchIndex) =>
    batch.sections.map((section, sectionIndex) => ({ id: `b${batchIndex + 1}s${sectionIndex + 1}`, section })),
  );
}

export function fallbackSectionGroups(indexed: IndexedSection[]): SectionGroup[] {
  const groups = new Map<string, SectionGroup>();
  for (const item of indexed) {
    const key = item.section.unitId?.trim() || item.section.name.trim().toLocaleLowerCase() || item.id;
    const group = groups.get(key) ?? { name: item.section.name || '未分类部位', sectionIds: [] };
    group.sectionIds.push(item.id);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function mergeBatchPartsLists(batches: PartsList[], proposedGroups: SectionGroup[]): PartsList {
  const indexed = indexBatchSections(batches);
  const byId = new Map(indexed.map((item) => [item.id, item.section]));
  const assigned = new Set<string>();
  const groups: SectionGroup[] = [];

  for (const proposed of proposedGroups) {
    const candidateIds = [...new Set(proposed.sectionIds)].filter((id) => byId.has(id) && !assigned.has(id));
    const firstUnitId = candidateIds.map((id) => byId.get(id)?.unitId).find((id) => id);
    const sectionIds = firstUnitId ? candidateIds.filter((id) => byId.get(id)?.unitId === firstUnitId) : candidateIds;
    if (!sectionIds.length) continue;
    sectionIds.forEach((id) => assigned.add(id));
    groups.push({ name: proposed.name.trim() || byId.get(sectionIds[0])!.name, sectionIds });
  }
  for (const item of indexed) {
    if (!assigned.has(item.id)) groups.push({ name: item.section.name, sectionIds: [item.id] });
  }

  const sections = groups.map((group) => mergeSections(group.name, group.sectionIds.map((id) => byId.get(id)!)));
  const uncertainItems = deduplicateUncertainItems(batches.flatMap((batch) => batch.uncertainItems));
  return { sections, uncertainItems };
}

function mergeSections(name: string, sections: AssemblySection[]): AssemblySection {
  const sourcePages = uniqueSorted(sections.flatMap((section) => section.sourcePages ?? []));
  const plates = new Map<string, Map<string, PartItem>>();
  for (const section of sections) {
    for (const plate of section.plates) {
      const plateCode = plate.code.toUpperCase();
      const parts = plates.get(plateCode) ?? new Map<string, PartItem>();
      for (const part of plate.parts) {
        const current = parts.get(part.number);
        if (!current) {
          parts.set(part.number, { ...part, sourcePages: uniqueSorted(part.sourcePages ?? []) });
          continue;
        }
        parts.set(part.number, {
          number: part.number,
          ...(preferredName(current.name, part.name) ? { name: preferredName(current.name, part.name) } : {}),
          // The same label commonly reappears in later assembly steps. Taking
          // the maximum preserves an explicitly detected multiplicity without
          // double-counting repeated references across batches.
          quantity: Math.max(current.quantity, part.quantity),
          sourcePages: uniqueSorted([...(current.sourcePages ?? []), ...(part.sourcePages ?? [])]),
        });
      }
      plates.set(plateCode, parts);
    }
  }
  return {
    ...(sections[0].unitId ? { unitId: sections[0].unitId } : {}),
    name,
    ...(sections.some((section) => section.multiplier) ? { multiplier: Math.max(...sections.map((section) => section.multiplier ?? 1)) } : {}),
    ...(sourcePages.length ? { sourcePages } : {}),
    plates: [...plates.entries()].map(([code, parts]) => ({ code, parts: [...parts.values()] })),
  };
}

function preferredName(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return right.length > left.length ? right : left;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function deduplicateUncertainItems(items: UncertainItem[]): UncertainItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.description}\n${item.suggestedAction ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
