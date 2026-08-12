import { PartsList } from '../domain';
import { mergeBatchPartsLists } from './parts-list-merger';

describe('batch parts-list merger', () => {
  const batches: PartsList[] = [
    {
      sections: [{
        name: '头部骨架', sourcePages: [1, 2],
        plates: [{ code: 'A1', parts: [{ number: '7', name: '连接件', quantity: 1, sourcePages: [1] }] }],
      }],
      uncertainItems: [{ description: '第2页模糊' }],
    },
    {
      sections: [
        {
          name: '头部外甲', sourcePages: [7, 8],
          plates: [
            { code: 'A1', parts: [{ number: '7', name: '头部连接件', quantity: 1, sourcePages: [7] }] },
            { code: 'A2', parts: [{ number: '3', quantity: 2, sourcePages: [8] }] },
          ],
        },
        {
          name: '手臂', sourcePages: [9],
          plates: [{ code: 'B1', parts: [{ number: '4', quantity: 1, sourcePages: [9] }] }],
        },
      ],
      uncertainItems: [{ description: '第2页模糊' }],
    },
  ];

  it('merges semantic section groups without double-counting repeated labels', () => {
    const result = mergeBatchPartsLists(batches, [{ name: '头部', sectionIds: ['b1s1', 'b2s1'] }]);
    expect(result.sections).toHaveLength(2);
    expect(result.sections[0].name).toBe('头部');
    expect(result.sections[0].sourcePages).toEqual([1, 2, 7, 8]);
    expect(result.sections[0].plates[0].parts[0]).toMatchObject({
      number: '7', name: '头部连接件', quantity: 1, sourcePages: [1, 7],
    });
    expect(result.sections[0].plates[1].parts[0].quantity).toBe(2);
    expect(result.uncertainItems).toEqual([{ description: '第2页模糊' }]);
  });

  it('preserves sections omitted by the LLM grouping response', () => {
    const result = mergeBatchPartsLists(batches, []);
    expect(result.sections.map((section) => section.name)).toEqual(['头部骨架', '头部外甲', '手臂']);
    expect(result.sections.flatMap((section) => section.plates).flatMap((plate) => plate.parts)).toHaveLength(4);
  });

  it('never merges sections with different visual assembly unit ids', () => {
    const separated: PartsList[] = [
      { sections: [{ unitId: 'step-2-head', name: '头部', sourcePages: [2], plates: [{ code: 'C1', parts: [{ number: '1', quantity: 1 }] }] }], uncertainItems: [] },
      { sections: [{ unitId: 'step-3-arms', name: '肩甲', sourcePages: [2], plates: [{ code: 'C1', parts: [{ number: '18', quantity: 2 }] }] }], uncertainItems: [] },
    ];
    const result = mergeBatchPartsLists(separated, [{ name: '头部', sectionIds: ['b1s1', 'b2s1'] }]);
    expect(result.sections).toHaveLength(2);
    expect(result.sections.map((section) => section.unitId)).toEqual(['step-2-head', 'step-3-arms']);
  });
});
