import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { find, kids, makeDoc, resolve, titleOf, type Topic, type XDoc } from '../src/core/model';
import { docFromOutline, runOp } from '../src/core/ops';
import { outlineOf, parseOutline } from '../src/core/outline';
import { parseXmind, serializeXmind } from '../src/core/xmind';

const ctx = { sheetIndex: 0 };
const root = (d: XDoc) => d.sheets[0].rootTopic;

describe('xmind 读写', () => {
  it('往返后保留未知字段和附加文件', () => {
    const doc = makeDoc('测试');
    root(doc).style = { id: 's1', properties: { 'svg:fill': '#fff' } };
    (doc.sheets[0] as Record<string, unknown>).relationships = [{ id: 'r1', end1Id: 'a', end2Id: 'b' }];
    doc.extra['resources/a.png'] = new Uint8Array([1, 2, 3]);
    const back = parseXmind(serializeXmind(doc));
    expect(root(back).style).toEqual({ id: 's1', properties: { 'svg:fill': '#fff' } });
    expect(back.sheets[0].relationships).toHaveLength(1);
    expect(Array.from(back.extra['resources/a.png'])).toEqual([1, 2, 3]);
  });

  it('能读官方 xmind CLI 生成的文件', () => {
    const path = process.env.XMIND_REF;
    if (!path) return;
    const doc = parseXmind(new Uint8Array(readFileSync(path)));
    expect(titleOf(root(doc))).toBe('中心主题');
    expect(kids(root(doc)).map(titleOf)).toEqual(['分支一', '分支二']);
  });

  it('只有中心主题带 class: topic（XMind 结构规则）', () => {
    const doc = docFromOutline('- 根\n  - 甲\n    - 乙');
    runOp(doc, 'add', { parent: '乙', title: '丙' }, ctx);
    runOp(doc, 'add_sheet', { markdown: '- 页二\n  - 子' }, ctx);
    for (const s of doc.sheets) {
      expect(s.rootTopic.class).toBe('topic');
      const bad: string[] = [];
      const visit = (t: Topic) => kids(t).forEach((c) => (c.class === 'topic' && bad.push(titleOf(c)), visit(c)));
      visit(s.rootTopic);
      expect(bad).toEqual([]);
    }
  });

  it('官方 xmind validate 校验通过', () => {
    const hasCli = spawnSync('xmind', ['--version']).status === 0;
    if (!hasCli) return;
    const doc = docFromOutline('- 规划\n  - 目标\n    - 增长\n  - 风险');
    runOp(doc, 'update', { id: '增长', labels: '重要', markers: 'priority-1', note: '备注\n第二行', href: 'https://example.com' }, ctx);
    runOp(doc, 'fold', { id: '目标', folded: true }, ctx);
    runOp(doc, 'add_sheet', { title: '第二页', markdown: '- 页二\n  - 子' }, ctx);
    const dir = mkdtempSync(join(tmpdir(), 'naotu-'));
    const file = join(dir, 'v.xmind');
    writeFileSync(file, serializeXmind(doc));
    const r = spawnSync('xmind', ['validate', file], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toMatch(/0 errors/);
  });

  it('拒绝 XMind 8 旧格式并给出可读提示', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const old = zipSync({ 'content.xml': strToU8('<xmap-content/>') });
    expect(() => parseXmind(old)).toThrow(/XMind 8/);
  });
});

describe('Markdown 大纲', () => {
  it('标题和列表混排，段落进备注', () => {
    const forest = parseOutline(`# 根\n## 一\n- a\n  - a1\n    说明文字\n- b\n## 二\n1. x\n2. y`);
    expect(forest).toHaveLength(1);
    const [one, two] = forest[0].children;
    expect(one.title).toBe('一');
    expect(one.children.map((n) => n.title)).toEqual(['a', 'b']);
    expect(one.children[0].children[0]).toMatchObject({ title: 'a1', note: '说明文字' });
    expect(two.children.map((n) => n.title)).toEqual(['x', 'y']);
  });

  it('4 空格缩进和 tab 缩进都能识别层级', () => {
    const forest = parseOutline(`- a\n    - b\n\t\t- c\n- d`);
    expect(forest.map((n) => n.title)).toEqual(['a', 'd']);
    expect(forest[0].children[0].children[0].title).toBe('c');
  });

  it('naotu show 的输出能原样贴回去', () => {
    const doc = docFromOutline('- 根\n  - 甲\n    - 乙');
    const text = outlineOf(doc.sheets[0]);
    const again = docFromOutline(text);
    expect(outlineOf(again.sheets[0], { ids: false })).toBe(outlineOf(doc.sheets[0], { ids: false }));
  });

  it('单个顶层条目自动成为中心主题', () => {
    const doc = docFromOutline('- 产品规划\n  - 目标\n  - 节奏');
    expect(titleOf(root(doc))).toBe('产品规划');
    expect(kids(root(doc)).map(titleOf)).toEqual(['目标', '节奏']);
  });
});

describe('操作', () => {
  it('add / update / move / delete 全流程', () => {
    const doc = makeDoc('根');
    const a = runOp(doc, 'add', { parent: 'root', titles: ['甲', '乙'] }, ctx);
    const [jia, yi] = (a.result as { ids: string[] }).ids;
    runOp(doc, 'add', { parent: jia.slice(0, 6), title: '甲一', note: '备注' }, ctx);
    runOp(doc, 'update', { id: '甲一', title: '甲-1', labels: '重要,本周', markers: ['priority-1'] }, ctx);
    const t = resolve(doc.sheets[0], '甲-1').topic;
    expect(t.attributedTitle).toEqual([{ text: '甲-1' }]);
    expect(t.labels).toEqual(['重要', '本周']);
    expect(t.notes?.plain?.content).toBe('备注');

    runOp(doc, 'move', { id: t.id, parent: yi, index: 0 }, ctx);
    expect(find(root(doc), yi)!.topic.children!.attached![0].id).toBe(t.id);
    expect(() => runOp(doc, 'move', { id: yi, parent: t.id }, ctx)).toThrow(/子树/);

    const d = runOp(doc, 'delete', { ids: [yi, t.id] }, ctx);
    expect(d.result).toEqual({ deleted: 2 });
    expect(kids(root(doc)).map(titleOf)).toEqual(['甲']);
  });

  it('同名标题报歧义而不是选错', () => {
    const doc = docFromOutline('- 根\n  - 重复\n  - 重复');
    expect(() => runOp(doc, 'add', { parent: '重复', title: 'x' }, ctx)).toThrow(/多个主题/);
  });

  it('不能删中心主题、不能折叠叶子', () => {
    const doc = docFromOutline('- 根\n  - 叶');
    expect(() => runOp(doc, 'delete', { id: 'root' }, ctx)).toThrow();
    expect(() => runOp(doc, 'fold', { id: '叶', folded: true }, ctx)).toThrow();
  });

  it('add_outline 批量插入并返回全部新 id', () => {
    const doc = makeDoc('根');
    const r = runOp(doc, 'add_outline', { parent: 'root', markdown: '- a\n  - a1\n  - a2\n- b' }, ctx);
    expect(r.touched).toHaveLength(4);
    expect(outlineOf(doc.sheets[0], { ids: false })).toBe('# 根\n- a\n  - a1\n  - a2\n- b');
  });

  it('多画布：add_sheet 后可按序号或标题定位', () => {
    const doc = makeDoc('根');
    runOp(doc, 'add_sheet', { title: '第二页', markdown: '- 页二根\n  - 子' }, ctx);
    const r = runOp(doc, 'read', { sheet: '第二页', format: 'markdown' }, ctx);
    expect(r.result).toBe('# 页二根\n- 子');
    expect(() => runOp(doc, 'read', { sheet: 5 }, ctx)).toThrow(/超出范围/);
  });
});
