// 文档操作的唯一实现。桌面应用（键盘操作 + agent 远程调用）和 CLI 离线模式都走这里，
// 所以界面和 agent 看到的行为永远一致。

import {
  LEFT_STRUCTURE,
  MAP_STRUCTURE,
  OpError,
  RIGHT_STRUCTURE,
  attachedOf,
  countTopics,
  isDescendant,
  isFolded,
  kids,
  makeDoc,
  makeSheet,
  makeTopic,
  resolve,
  resolveSheet,
  setFolded,
  setNote,
  setTitle,
  titleOf,
  type LayoutKind,
  type Topic,
  type XDoc,
} from './model';
import { outlineOf, parseOutline, toTopic, treeOf, type ONode } from './outline';

export interface OpContext {
  /** 未指定 sheet 参数时操作哪个画布（应用里是当前显示的画布） */
  sheetIndex: number;
}

export interface OpResult {
  result: unknown;
  changed: boolean;
  /** 被新增或修改的主题 id，界面据此高亮 */
  touched?: string[];
  /** 操作后建议选中的主题 */
  select?: string;
  /** 切换到的画布 */
  sheetIndex?: number;
}

type Params = Record<string, unknown>;

const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));

function list(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function insertAt(arr: Topic[], items: Topic[], index: unknown) {
  const i = index === undefined || index === null ? arr.length : Math.min(Math.max(0, Number(index)), arr.length);
  if (Number.isNaN(i)) throw new OpError('index 必须是数字');
  arr.splice(i, 0, ...items);
}

/** agent 能调用的文档操作（不含 open/save/undo 这类应用级动作）。 */
export const DOC_METHODS = [
  'read',
  'sheets',
  'add',
  'add_outline',
  'update',
  'move',
  'delete',
  'fold',
  'layout',
  'add_sheet',
  'rename_sheet',
] as const;

export function runOp(doc: XDoc, method: string, p: Params, ctx: OpContext): OpResult {
  const si = resolveSheet(doc, p.sheet, ctx.sheetIndex);
  const sheet = doc.sheets[si];

  switch (method) {
    case 'read': {
      const format = str(p.format) ?? 'outline';
      if (format === 'json') return { result: treeOf(sheet.rootTopic), changed: false };
      if (format === 'markdown') return { result: outlineOf(sheet, { ids: false }), changed: false };
      return { result: outlineOf(sheet), changed: false };
    }

    case 'sheets':
      return {
        result: doc.sheets.map((s, i) => ({ index: i, id: s.id, title: s.title, root: titleOf(s.rootTopic), topics: countTopics(s.rootTopic) })),
        changed: false,
      };

    case 'add': {
      const parent = resolve(sheet, str(p.parent)).topic;
      const titles = p.titles !== undefined ? list(p.titles) ?? [] : [str(p.title) ?? ''];
      if (!titles.length || titles.some((t) => !t.trim())) throw new OpError('add 需要非空的 title 或 titles');
      const created = titles.map((t) => makeTopic(t));
      const note = str(p.note);
      if (note && created.length === 1) setNote(created[0], note);
      insertAt(attachedOf(parent), created, p.index);
      setFolded(parent, false);
      const ids = created.map((t) => t.id);
      return { result: { ids }, changed: true, touched: ids, select: ids[ids.length - 1] };
    }

    case 'add_outline': {
      const parent = resolve(sheet, str(p.parent)).topic;
      const md = str(p.markdown);
      if (!md?.trim()) throw new OpError('add_outline 需要 markdown');
      const forest = parseOutline(md);
      if (!forest.length) throw new OpError('markdown 里没有解析到任何条目');
      const created = forest.map(toTopic);
      insertAt(attachedOf(parent), created, p.index);
      setFolded(parent, false);
      const touched: string[] = [];
      const collect = (t: Topic) => {
        touched.push(t.id);
        kids(t).forEach(collect);
      };
      created.forEach(collect);
      return { result: { ids: created.map((t) => t.id), total: touched.length }, changed: true, touched, select: created[0].id };
    }

    case 'update': {
      const t = resolve(sheet, str(p.id)).topic;
      let changed = false;
      if (p.title !== undefined) {
        const title = String(p.title);
        if (!title.trim()) throw new OpError('标题不能为空');
        setTitle(t, title);
        changed = true;
      }
      if (p.note !== undefined) {
        setNote(t, str(p.note));
        changed = true;
      }
      const labels = list(p.labels);
      if (labels) {
        if (labels.length) t.labels = labels;
        else delete t.labels;
        changed = true;
      }
      const markers = list(p.markers);
      if (markers) {
        if (markers.length) t.markers = markers.map((markerId) => ({ markerId }));
        else delete t.markers;
        changed = true;
      }
      if (p.href !== undefined) {
        const href = str(p.href);
        if (href) t.href = href;
        else delete t.href;
        changed = true;
      }
      if (!changed) throw new OpError('update 至少要给 title / note / labels / markers / href 之一');
      return { result: { id: t.id }, changed: true, touched: [t.id] };
    }

    case 'move': {
      const target = resolve(sheet, str(p.id));
      if (!target.parent) throw new OpError('中心主题不能移动');
      const parent = resolve(sheet, str(p.parent)).topic;
      if (isDescendant(target.topic, parent.id)) throw new OpError('不能把主题移到它自己的子树里');
      const from = attachedOf(target.parent);
      from.splice(target.index, 1);
      insertAt(attachedOf(parent), [target.topic], p.index);
      setFolded(parent, false);
      return { result: { id: target.topic.id }, changed: true, touched: [target.topic.id], select: target.topic.id };
    }

    case 'delete': {
      const refs = list(p.ids) ?? [str(p.id) ?? ''];
      // 先全部解析再删，避免删到一半才发现某个 id 不存在
      const found = refs.map((r) => resolve(sheet, r));
      for (const f of found) if (!f.parent) throw new OpError('中心主题不能删除');
      let next: string | undefined;
      for (const f of found) {
        if (!isDescendant(sheet.rootTopic, f.topic.id)) continue; // 已随祖先一起删除
        const siblings = attachedOf(f.parent!);
        const i = siblings.findIndex((s) => s.id === f.topic.id);
        if (i < 0) continue;
        siblings.splice(i, 1);
        next = (siblings[i] ?? siblings[i - 1] ?? f.parent!).id;
      }
      return { result: { deleted: found.length }, changed: true, select: next };
    }

    case 'fold': {
      const t = resolve(sheet, str(p.id)).topic;
      const folded = p.folded === undefined ? !isFolded(t) : Boolean(p.folded) && p.folded !== 'false';
      if (folded && !kids(t).length) throw new OpError('没有子主题的节点不能折叠');
      setFolded(t, folded);
      return { result: { id: t.id, folded }, changed: true, touched: [t.id] };
    }

    case 'layout': {
      const kind = str(p.layout) as LayoutKind | undefined;
      const map: Record<LayoutKind, string> = { map: MAP_STRUCTURE, right: RIGHT_STRUCTURE, left: LEFT_STRUCTURE };
      if (!kind || !(kind in map)) throw new OpError('layout 只支持 map / right / left');
      sheet.rootTopic.structureClass = map[kind];
      return { result: { layout: kind }, changed: true };
    }

    case 'add_sheet': {
      const title = str(p.title) ?? `画布 ${doc.sheets.length + 1}`;
      const md = str(p.markdown);
      const s = makeSheet(title, str(p.root) ?? '中心主题');
      if (md?.trim()) {
        const built = docFromOutline(md, str(p.root));
        s.rootTopic = built.sheets[0].rootTopic;
      }
      doc.sheets.push(s);
      return { result: { index: doc.sheets.length - 1, id: s.id }, changed: true, sheetIndex: doc.sheets.length - 1 };
    }

    case 'rename_sheet': {
      const title = str(p.title);
      if (!title?.trim()) throw new OpError('rename_sheet 需要 title');
      sheet.title = title;
      return { result: { index: si }, changed: true };
    }
  }
  throw new OpError(`未知操作 "${method}"`);
}

/**
 * 从 Markdown 大纲建新文档。规则：显式 title 优先做中心主题；否则只有一个顶层条目时它就是中心主题；
 * 再否则中心主题叫「中心主题」，顶层条目都挂在它下面。
 */
export function docFromOutline(md: string | undefined, title?: string): XDoc {
  const doc = makeDoc(title || '中心主题');
  if (!md?.trim()) return doc;
  let forest: ONode[] = parseOutline(md);
  const root = doc.sheets[0].rootTopic;
  if (!title && forest.length === 1) {
    setTitle(root, forest[0].title);
    if (forest[0].note) setNote(root, forest[0].note);
    forest = forest[0].children;
  }
  if (forest.length) root.children = { attached: forest.map(toTopic) };
  return doc;
}
