import { definitionValue, parseListPage } from './bandai-manuals.service';
import { inferSplitColumns } from './pdf-renderer';

describe('BandaiManualsService helpers', () => {
  it('parses product identity, names, date, detail URL, and cover URL', () => {
    const html = `
      <div class="bl_result_item">
        <a href="/menus/detail/5255">
          <div class="bl_result_img"><img src="https://bandai-hobby.net/images/2825365.jpg"></div>
          <div class="bl_result_detail">
            <div class="bl_result_name">
              30MM 1/144 xEXM-000 ゼノヴァルト
              <span class="bl_result_name_en">30MM 1/144 xEXM-001 XENOVALT</span>
            </div>
            <dl class="bl_result_caption"><dt>発売日</dt><dd>2026年7月25日発売</dd></dl>
          </div>
        </a>
      </div>`;

    expect(parseListPage(html)).toEqual([
      expect.objectContaining({
        manualId: '5255',
        title: '30MM 1/144 xEXM-000 ゼノヴァルト',
        titleEn: '30MM 1/144 xEXM-001 XENOVALT',
        releaseDate: '2026年7月25日発売',
        detailUrl: 'https://manual.bandai-hobby.net/menus/detail/5255',
        coverUrl: 'https://bandai-hobby.net/images/2825365.jpg',
      }),
    ]);
  });

  it('keeps both Japanese and English product names searchable in parsed results', () => {
    const html = `<a href="/menus/detail/5281">
      <div class="bl_result_img"><img src="/cover.jpg"></div>
      <div class="bl_result_name">HG 1/144 ガンダムレオパルド
        <span class="bl_result_name_en">HG 1/144 GUNDAM LEOPARD</span>
      </div>
    </a>`;
    const manual = parseListPage(html)[0];
    expect(`${manual.title} ${manual.titleEn}`).toContain('ガンダムレオパルド');
    expect(`${manual.title} ${manual.titleEn}`).toContain('GUNDAM LEOPARD');
  });

  it('infers logical-page columns from imposed PDF dimensions', () => {
    expect(inferSplitColumns(1542.86, 443.11)).toBe(5);
    expect(inferSplitColumns(1440, 510.24)).toBe(4);
  });

  it('parses detail definitions whose terms contain inline SVG markup', () => {
    const html = `<dl class="bl_detail_box_item">
      <dt class="bl_detail_box_title">品番<span><svg><path d="x"></path></svg></span></dt>
      <dd class="bl_detail_box_txt">2805110</dd>
    </dl>`;
    expect(definitionValue(html, '品番')).toBe('2805110');
  });
});
