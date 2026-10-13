// XMind content.json 的数据形状。只声明我们读写的字段，其余字段（样式、关系线、概要等）
// 通过索引签名原样保留，保证存回 .xmind 时不丢信息。

export interface Topic {
  id: string;
  class?: string;
  title?: string;
  attributedTitle?: { text: string; [k: string]: unknown }[];
  titleUnedited?: boolean;
  children?: { attached?: Topic[]; detached?: Topic[]; [k: string]: unknown };
  notes?: { plain?: { content: string }; realHTML?: { content: string }; [k: string]: unknown };
  labels?: string[];
  markers?: { markerId: string; [k: string]: unknown }[];
  branch?: string;
  href?: string;
  structureClass?: string;
  [k: string]: unknown;
}

export interface Sheet {
  id: string;
  class?: string;
  title: string;
  rootTopic: Topic;
  [k: string]: unknown;
}

export interface XDoc {
  sheets: Sheet[];
  metadata: Record<string, unknown>;
  /** zip 里除 content.json / metadata.json / manifest.json 以外的条目（图片资源、缩略图等） */
  extra: Record<string, Uint8Array>;
}

export class OpError extends Error {}

export const MAP_STRUCTURE = 'org.xmind.ui.map.unbalanced';
export const RIGHT_STRUCTURE = 'org.xmind.ui.logic.right';
export const LEFT_STRUCTURE = 'org.xmind.ui.logic.left';

export const newId = (): string => crypto.randomUUID();

export const kids = (t: Topic): Topic[] => t.children?.attached ?? [];

export function attachedOf(t: Topic): Topic[] {
  if (!t.children) t.children = {};
  if (!t.children.attached) t.children.attached = [];
  return t.children.attached;
}

export const titleOf = (t: Topic): string => t.title ?? t.attributedTitle?.map((r) => r.text).join('') ?? '';

export function setTitle(t: Topic, title: string): void {
  t.title = title;
  // XMind 优先显示 attributedTitle（富文本），必须同步，否则改了标题在 XMind 里看不到
  if (t.attributedTitle) t.attributedTitle = [{ text: title }];
  if ('titleUnedited' in t) t.titleUnedited = false;
}

export const noteOf = (t: Topic): string => t.notes?.plain?.content ?? '';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function setNote(t: Topic, note: string | null | undefined): void {
  if (!note) {
    delete t.notes;
    return;
  }
  // 整体替换：旧的 realHTML / ops 富文本若保留，XMind 会优先显示旧内容
  t.notes = {
    plain: { content: note },
    realHTML: { content: note.split('\n').map((l) => `<div>${escapeHtml(l) || '<br>'}</div>`).join('') },
  };
}

export const isFolded = (t: Topic): boolean => t.branch === 'folded';

export function setFolded(t: Topic, folded: boolean): void {
  if (folded) t.branch = 'folded';
  else delete t.branch;
}

// XMind 规定只有中心主题带 class: "topic"，子主题带了会被判为结构错误（xmind validate 可验证）
export function makeTopic(title: string): Topic {
  return { id: newId(), title, attributedTitle: [{ text: title }], titleUnedited: false };
}

export function makeSheet(title: string, rootTitle: string): Sheet {
  const root = makeTopic(rootTitle);
  root.class = 'topic';
  root.structureClass = MAP_STRUCTURE;
  return { id: newId(), class: 'sheet', title, rootTopic: root, topicPositioning: 'fixed', extensions: [], theme: { id: newId() } };
}

export function makeDoc(rootTitle = '中心主题'): XDoc {
  const sheet = makeSheet('画布 1', rootTitle);
  return {
    sheets: [sheet],
    metadata: {
      dataStructureVersion: '2',
      layoutEngineVersion: '2',
      creator: { name: 'naotu', version: '0.1.0' },
      activeSheetId: sheet.id,
    },
    extra: {},
  };
}

export interface Found {
  topic: Topic;
  parent: Topic | null;
  index: number;
  depth: number;
}

/** 深度优先遍历 attached 子树（含折叠分支）。回调返回 false 时不再深入该节点。 */
export function walk(root: Topic, fn: (f: Found) => boolean | void): void {
  const visit = (topic: Topic, parent: Topic | null, index: number, depth: number) => {
    if (fn({ topic, parent, index, depth }) === false) return;
    kids(topic).forEach((c, i) => visit(c, topic, i, depth + 1));
  };
  visit(root, null, 0, 0);
}

export function find(root: Topic, id: string): Found | null {
  let hit: Found | null = null;
  walk(root, (f) => {
    if (hit) return false;
    if (f.topic.id === id) hit = f;
  });
  return hit;
}

export function isDescendant(ancestor: Topic, id: string): boolean {
  return find(ancestor, id) !== null;
}

export function countTopics(root: Topic): number {
  let n = 0;
  walk(root, () => {
    n++;
  });
  return n;
}

/**
 * 把 agent 传来的引用解析成主题：支持 "root"、完整 id、id 前缀（≥4 位）、唯一的完整标题。
 * agent 常拿标题或短 id 指代节点，这里给出可读的歧义报错，而不是静默选错。
 */
export function resolve(sheet: Sheet, ref: string | undefined | null): Found {
  const root = sheet.rootTopic;
  const r = (ref ?? 'root').trim();
  if (r === '' || r === 'root') return { topic: root, parent: null, index: 0, depth: 0 };

  const all: Found[] = [];
  walk(root, (f) => {
    all.push(f);
  });

  const exact = all.find((f) => f.topic.id === r);
  if (exact) return exact;

  if (r.length >= 4) {
    const pre = all.filter((f) => f.topic.id.startsWith(r));
    if (pre.length === 1) return pre[0];
    if (pre.length > 1) throw new OpError(`id 前缀 "${r}" 匹配到 ${pre.length} 个主题，请多给几位`);
  }

  const byTitle = all.filter((f) => titleOf(f.topic).trim() === r);
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length > 1) {
    const ids = byTitle.map((f) => f.topic.id.slice(0, 8)).join(', ');
    throw new OpError(`标题 "${r}" 对应多个主题（${ids}），请改用 id`);
  }
  throw new OpError(`找不到主题 "${r}"（可用 id、id 前缀、唯一标题或 root）`);
}

export function resolveSheet(doc: XDoc, ref: unknown, fallback: number): number {
  if (ref === undefined || ref === null || ref === '') return clampSheet(doc, fallback);
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const i = Number(ref);
    if (i < 0 || i >= doc.sheets.length) throw new OpError(`画布序号 ${i} 超出范围（共 ${doc.sheets.length} 个，从 0 开始）`);
    return i;
  }
  const s = String(ref);
  const i = doc.sheets.findIndex((sh) => sh.id === s || sh.title === s);
  if (i < 0) throw new OpError(`找不到画布 "${s}"`);
  return i;
}

export function clampSheet(doc: XDoc, i: number): number {
  return Math.min(Math.max(0, i), doc.sheets.length - 1);
}

export function activeSheetIndex(doc: XDoc): number {
  const id = doc.metadata.activeSheetId;
  const i = doc.sheets.findIndex((s) => s.id === id);
  return i < 0 ? 0 : i;
}

export type LayoutKind = 'map' | 'right' | 'left';

export function layoutKind(root: Topic): LayoutKind {
  const s = root.structureClass ?? '';
  if (s.includes('logic.right')) return 'right';
  if (s.includes('logic.left')) return 'left';
  return 'map';
}

/** 地图布局下右侧放几个一级分支：优先读 XMind 的 unbalanced 扩展里的 right-number。 */
export function rightCount(sheet: Sheet, n: number): number {
  const exts = (sheet.extensions as { provider?: string; content?: { name?: string; content?: string }[] }[] | undefined) ?? [];
  const ext = exts.find((e) => e.provider === MAP_STRUCTURE);
  const rn = ext?.content?.find((c) => c.name === 'right-number')?.content;
  const v = rn === undefined ? NaN : Number(rn);
  return Number.isFinite(v) ? Math.min(Math.max(0, v), n) : Math.ceil(n / 2);
}

/** 深拷贝主题并换新 id（粘贴、复制分支时用，避免 id 冲突）。 */
export function cloneWithNewIds(t: Topic): Topic {
  const c = structuredClone(t);
  const renew = (x: Topic) => {
    x.id = newId();
    kids(x).forEach(renew);
    x.children?.detached?.forEach(renew);
  };
  renew(c);
  return c;
}
