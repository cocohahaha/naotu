import { isFolded, kids, layoutKind, noteOf, rightCount, titleOf, type Sheet, type Topic } from '../core/model';

export const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", sans-serif';

export interface Tier {
  size: number;
  weight: number;
  lineH: number;
  padX: number;
  padY: number;
  maxW: number;
  radius: number;
  minW: number;
}

// 三级字号：中心主题 / 分支主题 / 子主题。更深的层级沿用子主题样式。
export const TIERS: Tier[] = [
  { size: 20, weight: 600, lineH: 28, padX: 24, padY: 14, maxW: 320, radius: 10, minW: 96 },
  { size: 15, weight: 500, lineH: 22, padX: 14, padY: 8, maxW: 280, radius: 7, minW: 48 },
  { size: 14, weight: 400, lineH: 20, padX: 8, padY: 5, maxW: 260, radius: 5, minW: 28 },
];
export const tierOf = (depth: number) => TIERS[Math.min(depth, TIERS.length - 1)];
export const fontOf = (t: Tier) => `${t.weight} ${t.size}px ${FONT_FAMILY}`;

export const MARKER = 16;
export const MARKER_GAP = 5;
export const ICON = 16;
export const LABEL_H = 18;

const H_GAP = [48, 34, 26];
const V_GAP = [0, 22, 7];

let ctx: CanvasRenderingContext2D | null = null;
const widths = new Map<string, number>();

export function textWidth(s: string, font: string): number {
  const key = `${font}\u0000${s}`;
  let w = widths.get(key);
  if (w === undefined) {
    ctx ??= document.createElement('canvas').getContext('2d')!;
    ctx.font = font;
    w = ctx.measureText(s).width;
    if (widths.size > 20000) widths.clear();
    widths.set(key, w);
  }
  return w;
}

// 中日韩字符逐字可断，拉丁文按词断
const TOKEN = /[⺀-鿿豈-﫿＀-￯　-〿]|[^\s⺀-鿿豈-﫿＀-￯　-〿]+\s*|\s+/g;

export function wrap(text: string, font: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const tok of para.match(TOKEN) ?? ['']) {
      const cand = line + tok;
      if (line && textWidth(cand.trimEnd(), font) > maxW) {
        out.push(line.trimEnd());
        line = tok.trimStart();
      } else line = cand;
      // 超长单词硬断
      while (line.length > 1 && textWidth(line, font) > maxW) {
        let i = line.length - 1;
        while (i > 1 && textWidth(line.slice(0, i), font) > maxW) i--;
        out.push(line.slice(0, i));
        line = line.slice(i);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

export interface Box {
  id: string;
  topic: Topic;
  parent: string | null;
  depth: number;
  dir: 1 | -1;
  x: number;
  y: number;
  w: number;
  h: number;
  tier: Tier;
  lines: string[];
  markers: string[];
  labels: string[];
  note: string;
  href: string;
  kidCount: number;
  folded: boolean;
  children: Box[];
  sub: number;
}

export interface Edge {
  key: string;
  d: string;
  depth: number;
}

export interface Layout {
  boxes: Box[];
  byId: Map<string, Box>;
  edges: Edge[];
  bounds: { x: number; y: number; w: number; h: number };
}

export function measureTitle(text: string, depth: number) {
  const tier = tierOf(depth);
  const font = fontOf(tier);
  const lines = wrap(text || ' ', font, tier.maxW);
  const textW = Math.max(...lines.map((l) => textWidth(l, font)), 1);
  return { tier, lines, textW };
}

function measure(t: Topic, depth: number, dir: 1 | -1, parent: string | null): Box {
  const { tier, lines, textW } = measureTitle(titleOf(t), depth);
  const markers = (t.markers ?? []).map((m) => m.markerId);
  const labels = t.labels ?? [];
  const note = noteOf(t);
  const href = t.href ?? '';
  const markersW = markers.length * (MARKER + MARKER_GAP);
  const iconsW = (note ? ICON + 4 : 0) + (href ? ICON + 4 : 0);
  const labelW = labels.length ? textWidth(labels.join(' · '), `400 11px ${FONT_FAMILY}`) + 4 : 0;
  const w = Math.max(tier.minW, Math.ceil(Math.max(markersW + textW + iconsW, labelW) + tier.padX * 2));
  const h = Math.ceil(lines.length * tier.lineH + tier.padY * 2 + (labels.length ? LABEL_H : 0));
  const folded = isFolded(t) && kids(t).length > 0;
  const box: Box = {
    id: t.id,
    topic: t,
    parent,
    depth,
    dir,
    x: 0,
    y: 0,
    w,
    h,
    tier,
    lines,
    markers,
    labels,
    note,
    href,
    kidCount: kids(t).length,
    folded,
    children: [],
    sub: 0,
  };
  if (!folded) box.children = kids(t).map((c) => measure(c, depth + 1, dir, t.id));
  box.sub = subtree(box);
  return box;
}

function gapV(depth: number) {
  return V_GAP[Math.min(depth, V_GAP.length - 1)];
}
function gapH(depth: number) {
  return H_GAP[Math.min(depth, H_GAP.length - 1)];
}

function subtree(b: Box): number {
  if (!b.children.length) return b.h;
  const sum = b.children.reduce((s, c) => s + c.sub, 0) + gapV(b.depth + 1) * (b.children.length - 1);
  return Math.max(b.h, sum);
}

function stack(children: Box[], anchorX: number, cy: number, gap: number) {
  const total = children.reduce((s, c) => s + c.sub, 0) + gap * (children.length - 1);
  let y = cy - total / 2;
  for (const c of children) {
    place(c, anchorX, y + c.sub / 2);
    y += c.sub + gap;
  }
}

function place(b: Box, anchorX: number, cy: number) {
  b.y = cy - b.h / 2;
  b.x = b.dir > 0 ? anchorX : anchorX - b.w;
  if (!b.children.length) return;
  const next = b.dir > 0 ? b.x + b.w + gapH(b.depth) : b.x - gapH(b.depth);
  stack(b.children, next, cy, gapV(b.depth + 1));
}

export function computeLayout(sheet: Sheet): Layout {
  const rootTopic = sheet.rootTopic;
  const root = measure(rootTopic, 0, 1, null);
  const kind = layoutKind(rootTopic);
  const n = root.children.length;
  const rc = kind === 'right' ? n : kind === 'left' ? 0 : rightCount(sheet, n);

  const setDir = (b: Box, dir: 1 | -1) => {
    b.dir = dir;
    b.children.forEach((c) => setDir(c, dir));
  };
  const right = root.children.slice(0, rc);
  // 顺时针：右侧自上而下，左侧自下而上
  const left = root.children.slice(rc).reverse();
  left.forEach((b) => setDir(b, -1));

  root.x = -root.w / 2;
  root.y = -root.h / 2;
  stack(right, root.x + root.w + gapH(0), 0, gapV(1));
  stack(left, root.x - gapH(0), 0, gapV(1));

  const boxes: Box[] = [];
  const edges: Edge[] = [];
  const byId = new Map<string, Box>();
  const collect = (b: Box) => {
    boxes.push(b);
    byId.set(b.id, b);
    for (const c of b.children) {
      edges.push({ key: `${b.id}>${c.id}`, d: edgePath(b, c), depth: c.depth });
      collect(c);
    }
  };
  collect(root);

  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { boxes, byId, edges, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

function edgePath(p: Box, c: Box): string {
  const dir = c.dir;
  const x1 = dir > 0 ? p.x + p.w : p.x;
  const y1 = p.y + p.h / 2;
  const x2 = dir > 0 ? c.x : c.x + c.w;
  const y2 = c.y + c.h / 2;
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

/** 方向键导航：左右进出层级（按分支朝向），上下在同层同侧里找最近的主题 */
export function neighbor(layout: Layout, id: string, key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'): string | null {
  const b = layout.byId.get(id);
  if (!b) return null;
  const cy = b.y + b.h / 2;
  const nearestChild = (side: 1 | -1) => {
    const cs = b.parent === null ? b.children.filter((c) => c.dir === side) : b.children;
    if (!cs.length) return null;
    return cs.reduce((best, c) => (Math.abs(c.y + c.h / 2 - cy) < Math.abs(best.y + best.h / 2 - cy) ? c : best)).id;
  };

  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const side = key === 'ArrowRight' ? 1 : -1;
    if (b.parent === null) return nearestChild(side);
    return b.dir === side ? nearestChild(side) : b.parent;
  }

  const up = key === 'ArrowUp';
  let best: Box | null = null;
  for (const o of layout.boxes) {
    if (o === b || o.depth !== b.depth || o.dir !== b.dir || o.depth === 0) continue;
    const oy = o.y + o.h / 2;
    if (up ? oy >= cy : oy <= cy) continue;
    if (!best || Math.abs(oy - cy) < Math.abs(best.y + best.h / 2 - cy)) best = o;
  }
  return best?.id ?? null;
}
