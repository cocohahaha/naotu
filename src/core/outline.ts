import { isFolded, kids, makeTopic, noteOf, setNote, titleOf, type Sheet, type Topic } from './model';

export interface ONode {
  title: string;
  note?: string;
  children: ONode[];
}

const cleanTitle = (s: string) =>
  s
    .trim()
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .replace(/^__(.+)__$/, '$1')
    .replace(/\s+\[id:[0-9a-zA-Z-]+\].*$/, ''); // 允许把 naotu show 的输出直接贴回来

/**
 * Markdown 大纲 → 树。标题（#）和列表（- * + 1.）都算节点，层级 = 最近标题层级 + 列表缩进层级；
 * 普通段落挂到上一个节点的备注里。
 */
export function parseOutline(md: string): ONode[] {
  const roots: ONode[] = [];
  const stack: { level: number; node: ONode }[] = [];
  let headingLevel = 0;
  let indents: number[] = [];
  let last: ONode | null = null;
  let inFence = false;

  const push = (level: number, title: string) => {
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const node: ONode = { title, children: [] };
    const parent = stack[stack.length - 1]?.node;
    (parent ? parent.children : roots).push(node);
    stack.push({ level, node });
    last = node;
  };

  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !raw.trim()) continue;

    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      headingLevel = h[1].length;
      indents = [];
      push(headingLevel, cleanTitle(h[2]));
      continue;
    }

    const li = raw.match(/^([ \t]*)(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const width = li[1].replace(/\t/g, '    ').length;
      while (indents.length && width < indents[indents.length - 1]) indents.pop();
      if (!indents.length || width > indents[indents.length - 1]) indents.push(width);
      push(headingLevel + indents.length, cleanTitle(li[2]));
      continue;
    }

    const text = raw.trim().replace(/^>\s?/, '');
    const target = last as ONode | null;
    if (target) target.note = target.note ? `${target.note}\n${text}` : text;
    else push(headingLevel + 1, cleanTitle(text));
  }
  return roots;
}

export function toTopic(n: ONode): Topic {
  const t = makeTopic(n.title);
  if (n.note) setNote(t, n.note);
  if (n.children.length) t.children = { attached: n.children.map(toTopic) };
  return t;
}

export interface OutlineOptions {
  ids?: boolean;
  notes?: boolean;
}

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' / ');

/** 树 → 带 id 的缩进大纲，给 agent 读。folded 的分支也完整输出并标注。 */
export function outlineOf(sheet: Sheet, opts: OutlineOptions = {}): string {
  const { ids = true, notes = true } = opts;
  const lines: string[] = [];
  const meta = (t: Topic) => {
    const parts: string[] = [];
    if (ids) parts.push(`[id:${t.id.slice(0, 8)}]`);
    if (t.labels?.length) parts.push(`(标签: ${t.labels.join(', ')})`);
    if (t.markers?.length) parts.push(`(标记: ${t.markers.map((m) => m.markerId).join(', ')})`);
    if (t.href) parts.push(`(链接: ${t.href})`);
    if (isFolded(t) && kids(t).length) parts.push('(已折叠)');
    return parts.length ? ' ' + parts.join(' ') : '';
  };
  const noteLine = (t: Topic, indent: string) => {
    const n = noteOf(t);
    if (notes && n) lines.push(`${indent}  > ${oneLine(n).slice(0, 400)}`);
  };

  const root = sheet.rootTopic;
  lines.push(`# ${oneLine(titleOf(root))}${meta(root)}`);
  noteLine(root, '');
  const visit = (t: Topic, depth: number) => {
    const indent = '  '.repeat(depth);
    lines.push(`${indent}- ${oneLine(titleOf(t))}${meta(t)}`);
    noteLine(t, indent);
    kids(t).forEach((c) => visit(c, depth + 1));
  };
  kids(root).forEach((c) => visit(c, 0));
  const floating = root.children?.detached?.length ?? 0;
  if (floating) lines.push(`(另有 ${floating} 个自由主题，界面暂不显示，已原样保留)`);
  return lines.join('\n');
}

/** 子树 → 纯 Markdown 列表（复制分支到剪贴板时用）。 */
export function subtreeMarkdown(t: Topic): string {
  const lines: string[] = [];
  const visit = (x: Topic, depth: number) => {
    lines.push(`${'  '.repeat(depth)}- ${oneLine(titleOf(x))}`);
    kids(x).forEach((c) => visit(c, depth + 1));
  };
  visit(t, 0);
  return lines.join('\n');
}

export interface TreeNode {
  id: string;
  title: string;
  note?: string;
  labels?: string[];
  markers?: string[];
  href?: string;
  folded?: boolean;
  children: TreeNode[];
}

export function treeOf(t: Topic): TreeNode {
  const n: TreeNode = { id: t.id, title: titleOf(t), children: kids(t).map(treeOf) };
  const note = noteOf(t);
  if (note) n.note = note;
  if (t.labels?.length) n.labels = t.labels;
  if (t.markers?.length) n.markers = t.markers.map((m) => m.markerId);
  if (t.href) n.href = t.href;
  if (isFolded(t)) n.folded = true;
  return n;
}
