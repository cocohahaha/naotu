import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isDescendant, titleOf } from '../core/model';
import { FONT_FAMILY, ICON, LABEL_H, MARKER, MARKER_GAP, computeLayout, fontOf, measureTitle, textWidth, type Box, type Layout } from './layout';
import { store, useStore } from './store';

interface View {
  x: number;
  y: number;
  k: number;
}

/** 键盘导航需要读当前布局，由画布每次渲染时更新 */
export const layoutRef: { current: Layout | null } = { current: null };

const clampK = (k: number) => Math.min(3, Math.max(0.2, k));

type Gesture =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean }
  | { kind: 'node'; id: string; sx: number; sy: number; moved: boolean };

export function Canvas() {
  const doc = useStore((s) => s.doc);
  const rev = useStore((s) => s.rev);
  const sheet = useStore((s) => s.sheet);
  const selected = useStore((s) => s.selected);
  const editing = useStore((s) => s.editing);
  const flash = useStore((s) => s.flash);
  const reveal = useStore((s) => s.reveal);
  const viewCmd = useStore((s) => s.view);

  // rev 变化代表文档被原地修改，必须重新布局
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => (doc ? computeLayout(doc.sheets[Math.min(sheet, doc.sheets.length - 1)]) : null), [doc, rev, sheet]);
  layoutRef.current = layout;

  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;

  const gesture = useRef<Gesture | null>(null);
  const [drag, setDrag] = useState<{ id: string; wx: number; wy: number; target: string | null } | null>(null);

  const zoomAt = (px: number, py: number, factor: number) =>
    setView((v) => {
      const k = clampK(v.k * factor);
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });

  // 适应窗口 / 缩放命令
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!viewCmd || !layout || !el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    if (viewCmd.cmd === 'fit') {
      const b = layout.bounds;
      const k = clampK(Math.min(1, (w - 160) / b.w, (h - 160) / b.h));
      setView({ k, x: w / 2 - (b.x + b.w / 2) * k, y: h / 2 - (b.y + b.h / 2) * k });
    } else if (viewCmd.cmd === 'reset') setView({ k: 1, x: w / 2, y: h / 2 });
    else zoomAt(w / 2, h / 2, viewCmd.cmd === 'in' ? 1.2 : 1 / 1.2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewCmd]);

  useEffect(() => {
    store.set({ zoom: view.k });
  }, [view.k]);

  // 把指定主题滚进视野（键盘导航、agent 修改时）。每个请求只处理一次，
  // 否则之后任何一次重新布局都会把视野拽回旧位置。
  const revealed = useRef(0);
  useEffect(() => {
    const el = wrapRef.current;
    const b = reveal && layout?.byId.get(reveal.id);
    if (!el || !b || reveal.at === revealed.current) return;
    revealed.current = reveal.at;
    const { width: w, height: h } = el.getBoundingClientRect();
    const v = viewRef.current;
    const m = 60;
    const sx = v.x + b.x * v.k,
      sy = v.y + b.y * v.k,
      ex = sx + b.w * v.k,
      ey = sy + b.h * v.k;
    let dx = 0,
      dy = 0;
    if (sx < m) dx = m - sx;
    else if (ex > w - m) dx = Math.max(w - m - ex, m - sx);
    if (sy < m + 30) dy = m + 30 - sy;
    else if (ey > h - m) dy = Math.max(h - m - ey, m + 30 - sy);
    if (dx || dy) setView({ ...v, x: v.x + dx, y: v.y + dy });
  }, [reveal, layout]);

  // 触控板：双指滚动平移，捏合（ctrlKey）缩放
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.01));
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const toWorld = (cx: number, cy: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { wx: (cx - r.left - v.x) / v.k, wy: (cy - r.top - v.y) / v.k };
  };

  const hitTest = (wx: number, wy: number, dragId: string): string | null => {
    if (!layout) return null;
    const dragged = layout.byId.get(dragId)?.topic;
    for (const b of layout.boxes) {
      if (wx < b.x || wx > b.x + b.w || wy < b.y || wy > b.y + b.h) continue;
      if (b.id === dragId || (dragged && isDescendant(dragged, b.id))) return null;
      return b.id;
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const nodeEl = (e.target as Element).closest('[data-id]');
    const toggle = (e.target as Element).closest('[data-toggle]');
    if (toggle) return;
    if (nodeEl) {
      const id = nodeEl.getAttribute('data-id')!;
      if (store.get().editing?.id === id) return;
      store.select(id);
      gesture.current = { kind: 'node', id, sx: e.clientX, sy: e.clientY, moved: false };
    } else {
      const v = viewRef.current;
      gesture.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: v.x, vy: v.y, moved: false };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.sx,
      dy = e.clientY - g.sy;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
    // 真正开始拖动才捕获指针：过早捕获会让双击事件的 target 变成画布，进不了编辑
    if (!g.moved) (e.currentTarget as Element).setPointerCapture(e.pointerId);
    g.moved = true;
    if (g.kind === 'pan') setView((v) => ({ ...v, x: g.vx + dx, y: g.vy + dy }));
    else if (g.id !== doc?.sheets[sheet]?.rootTopic.id) {
      const { wx, wy } = toWorld(e.clientX, e.clientY);
      setDrag({ id: g.id, wx, wy, target: hitTest(wx, wy, g.id) });
    }
  };

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.kind === 'pan' && !g.moved) store.select(null);
    if (g.kind === 'node' && drag) {
      if (drag.target) store.moveTo(drag.id, drag.target);
      setDrag(null);
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const nodeEl = (e.target as Element).closest('[data-id]');
    if (nodeEl) store.startEdit(nodeEl.getAttribute('data-id'));
  };

  if (!doc || !layout) return null;
  const editBox = editing ? layout.byId.get(editing.id) : undefined;
  const dragBox = drag ? layout.byId.get(drag.id) : undefined;
  const flashSet = flash && Date.now() - flash.at < 2000 ? new Set(flash.ids) : null;

  return (
    <div
      ref={wrapRef}
      className={`canvas${drag ? ' dragging' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      <svg width="100%" height="100%">
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {layout.edges.map((ed) => (
            <path key={ed.key} d={ed.d} className={`edge e${Math.min(ed.depth, 2)}`} />
          ))}
          {layout.boxes.map((b) => (
            <NodeView
              key={b.id}
              b={b}
              selected={b.id === selected}
              editing={b.id === editing?.id}
              flashAt={flashSet?.has(b.id) ? flash!.at : 0}
              drop={b.id === drag?.target}
            />
          ))}
          {drag && dragBox && (
            <g className="ghost" transform={`translate(${drag.wx - dragBox.w / 2},${drag.wy - dragBox.h / 2})`}>
              <rect width={dragBox.w} height={dragBox.h} rx={dragBox.tier.radius} />
              <text x={dragBox.w / 2} y={dragBox.h / 2} textAnchor="middle" dominantBaseline="central" style={{ font: fontOf(dragBox.tier) }}>
                {dragBox.lines[0]}
              </text>
            </g>
          )}
        </g>
      </svg>
      {editing && editBox && <InlineEditor key={editing.id} box={editBox} view={view} />}
    </div>
  );
}

// ---------- 主题节点 ----------

const MARKER_COLORS: Record<string, string> = {
  red: '#C4554D',
  orange: '#C98A3D',
  yellow: '#B39A2F',
  green: '#5E8C61',
  blue: '#6E8DA8',
  purple: '#8A73A6',
};

function markerGlyph(id: string): { glyph: string; color: string; filled: boolean } {
  const [kind, rest = ''] = id.split('-');
  const color = MARKER_COLORS[rest] ?? 'var(--muted)';
  if (kind === 'priority') return { glyph: rest, color: 'var(--ink)', filled: true };
  if (kind === 'task') return { glyph: rest === 'done' ? '✓' : '◔', color: 'var(--ink)', filled: false };
  if (kind === 'star') return { glyph: '★', color, filled: false };
  if (kind === 'flag') return { glyph: '⚑', color, filled: false };
  if (kind === 'smiley') return { glyph: '☺', color, filled: false };
  if (kind === 'symbol' && rest === 'question') return { glyph: '?', color: 'var(--muted)', filled: false };
  return { glyph: '•', color, filled: false };
}

interface NodeProps {
  b: Box;
  selected: boolean;
  editing: boolean;
  flashAt: number;
  drop: boolean;
}

const NodeView = memo(function NodeView({ b, selected, editing, flashAt, drop }: NodeProps) {
  const t = b.tier;
  const firstY = t.padY + t.lineH / 2;
  const markersW = b.markers.length * (MARKER + MARKER_GAP);
  const textX = t.padX + markersW;
  const textW = Math.max(...b.lines.map((l) => textWidth(l, fontOf(t))), 0);
  const toggleX = b.dir > 0 ? b.w + 8 : -8;
  const cls = `node d${Math.min(b.depth, 2)}${selected ? ' selected' : ''}${drop ? ' drop' : ''}`;

  return (
    <g className={cls} transform={`translate(${b.x},${b.y})`} data-id={b.id}>
      <rect className="body" width={b.w} height={b.h} rx={t.radius} />
      {flashAt > 0 && <rect key={flashAt} className="flash" x={-4} y={-4} width={b.w + 8} height={b.h + 8} rx={t.radius + 4} />}
      {selected && <rect className="sel" x={-3.5} y={-3.5} width={b.w + 7} height={b.h + 7} rx={t.radius + 3} />}
      {!editing && (
        <>
          {b.markers.map((m, i) => {
            const g = markerGlyph(m);
            const cx = t.padX + i * (MARKER + MARKER_GAP) + MARKER / 2;
            return (
              <g key={m + i} className="marker">
                {g.filled && <circle cx={cx} cy={firstY} r={MARKER / 2} fill={g.color} />}
                <text x={cx} y={firstY + 0.5} textAnchor="middle" dominantBaseline="central" fill={g.filled ? '#fff' : g.color} style={{ font: `600 ${g.filled ? 10 : 13}px ${FONT_FAMILY}` }}>
                  {g.glyph}
                </text>
              </g>
            );
          })}
          {b.lines.map((line, i) => (
            <text key={i} className="label-text" x={textX} y={t.padY + i * t.lineH + t.lineH / 2} dominantBaseline="central" style={{ font: fontOf(t) }}>
              {line}
            </text>
          ))}
          {b.note && <NoteIcon x={textX + textW + 6} y={firstY} />}
          {b.href && (
            <text className="icon" x={textX + textW + 6 + (b.note ? ICON + 4 : 0) + ICON / 2} y={firstY} textAnchor="middle" dominantBaseline="central" style={{ font: `500 12px ${FONT_FAMILY}` }}>
              ↗
            </text>
          )}
          {b.labels.length > 0 && (
            <text className="labels" x={t.padX} y={t.padY + b.lines.length * t.lineH + LABEL_H / 2 + 1} dominantBaseline="central" style={{ font: `400 11px ${FONT_FAMILY}` }}>
              {b.labels.join(' · ')}
            </text>
          )}
        </>
      )}
      {b.kidCount > 0 && b.depth > 0 && (
        <g className={`toggle${b.folded ? ' folded' : ''}`} data-toggle="1" transform={`translate(${toggleX},${b.h / 2})`} onClick={() => store.toggleFold(b.id)}>
          <circle r={b.folded ? 8 : 6} />
          {b.folded ? (
            <text textAnchor="middle" dominantBaseline="central" style={{ font: `600 9px ${FONT_FAMILY}` }}>
              {b.kidCount > 99 ? '…' : b.kidCount}
            </text>
          ) : (
            <path d="M-3,0 H3" />
          )}
        </g>
      )}
      {b.note && <title>{b.note}</title>}
    </g>
  );
});

function NoteIcon({ x, y }: { x: number; y: number }) {
  return (
    <g className="icon" transform={`translate(${x},${y - 6})`}>
      <rect width={11} height={12} rx={2} fill="none" />
      <path d="M3,4 H8 M3,6.5 H8 M3,9 H6" />
    </g>
  );
}

// ---------- 原地编辑 ----------

function InlineEditor({ box, view }: { box: Box; view: View }) {
  const [text, setText] = useState(() => titleOf(box.topic));
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const t = box.tier;

  useLayoutEffect(() => {
    const el = ref.current!;
    el.focus();
    el.select();
  }, []);

  const m = measureTitle(text || ' ', box.depth);
  const markersW = box.markers.length * (MARKER + MARKER_GAP);
  const w = Math.max(t.minW, Math.ceil(m.textW + markersW + t.padX * 2) + 4);
  const h = m.lines.length * t.lineH + t.padY * 2;
  // 编辑框从节点“生长出去”的方向和分支方向一致
  const wx = box.depth === 0 ? box.x + box.w / 2 - w / 2 : box.dir > 0 ? box.x : box.x + box.w - w;
  const wy = box.y;

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) store.commitEdit(text);
    else store.cancelEdit();
  };

  return (
    <textarea
      ref={ref}
      className={`editor d${Math.min(box.depth, 2)}`}
      value={text}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(true)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // 中文输入法组字时的回车只是确认候选词，不能当提交
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          finish(true);
          store.addChild();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
      style={{
        left: view.x + wx * view.k,
        top: view.y + wy * view.k,
        width: w,
        height: h,
        transform: `scale(${view.k})`,
        font: fontOf(t),
        lineHeight: `${t.lineH}px`,
        padding: `${t.padY}px ${t.padX}px ${t.padY}px ${t.padX + markersW}px`,
        borderRadius: t.radius,
      }}
    />
  );
}
