import { useSyncExternalStore } from 'react';
import {
  OpError,
  activeSheetIndex,
  attachedOf,
  clampSheet,
  cloneWithNewIds,
  countTopics,
  find,
  kids,
  makeDoc,
  resolve,
  titleOf,
  type Sheet,
  type Topic,
  type XDoc,
} from '../core/model';
import { docFromOutline, runOp, type OpResult } from '../core/ops';
import { subtreeMarkdown } from '../core/outline';
import { parseXmind, serializeXmind } from '../core/xmind';
import { baseName, confirm, fileMtime, focusWindow, isTauri, pickOpen, pickSave, readFile, setWindowTitle, writeFile } from './platform';

export interface EditState {
  id: string;
  isNew: boolean;
}

export interface AppState {
  doc: XDoc | null;
  path: string | null;
  dirty: boolean;
  sheet: number;
  selected: string | null;
  editing: EditState | null;
  notesOpen: boolean;
  /** 每次文档内容变化 +1，画布据此重新布局 */
  rev: number;
  /** agent 刚改过的主题，短暂高亮 */
  flash: { ids: string[]; at: number } | null;
  toast: { text: string; tone: 'info' | 'agent' | 'error'; at: number } | null;
  /** 请求画布滚动到某个主题 */
  reveal: { id: string; at: number } | null;
  /** 请求画布缩放：fit / in / out / reset */
  view: { cmd: 'fit' | 'in' | 'out' | 'reset'; at: number } | null;
  zoom: number;
  recent: string[];
}

interface Snapshot {
  sheets: Sheet[];
  sheet: number;
  selected: string | null;
}

export type Source = 'user' | 'agent';

const RECENT_KEY = 'naotu.recent';
const loadRecent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
};

const TOAST_VERB: Record<string, (r: OpResult) => string> = {
  add: (r) => `新增 ${(r.result as { ids: string[] }).ids.length} 个主题`,
  add_outline: (r) => `新增 ${(r.result as { total: number }).total} 个主题`,
  update: () => '修改了主题',
  move: () => '移动了主题',
  delete: (r) => `删除了 ${(r.result as { deleted: number }).deleted} 个主题`,
  fold: (r) => ((r.result as { folded: boolean }).folded ? '折叠了分支' : '展开了分支'),
  layout: () => '切换了布局',
  add_sheet: () => '新建了画布',
  rename_sheet: () => '重命名了画布',
};

class Store {
  state: AppState = {
    doc: null,
    path: null,
    dirty: false,
    sheet: 0,
    selected: null,
    editing: null,
    notesOpen: false,
    rev: 0,
    flash: null,
    toast: null,
    reveal: null,
    view: null,
    zoom: 1,
    recent: loadRecent(),
  };

  private listeners = new Set<() => void>();
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private savedMtime = 0;
  private clip: { text: string; topic: Topic } | null = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  get = () => this.state;

  set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  // ---------- 查询 ----------

  get sheetObj(): Sheet | null {
    const { doc, sheet } = this.state;
    return doc ? doc.sheets[clampSheet(doc, sheet)] : null;
  }

  topic(id: string | null): Topic | null {
    const s = this.sheetObj;
    return s && id ? find(s.rootTopic, id)?.topic ?? null : null;
  }

  status() {
    const { doc, path, dirty, sheet, selected } = this.state;
    if (!doc) return { app: 'naotu', open: false };
    const s = this.sheetObj!;
    const sel = this.topic(selected);
    return {
      app: 'naotu',
      open: true,
      file: path,
      title: titleOf(s.rootTopic),
      dirty,
      sheet: { index: sheet, title: s.title },
      sheets: doc.sheets.map((x, i) => ({ index: i, title: x.title })),
      selected: sel ? { id: sel.id, title: titleOf(sel) } : null,
      topics: countTopics(s.rootTopic),
    };
  }

  toast(text: string, tone: 'info' | 'agent' | 'error' = 'info') {
    this.set({ toast: { text, tone, at: Date.now() } });
  }

  // ---------- 文档生命周期 ----------

  private load(doc: XDoc, path: string | null) {
    this.undoStack = [];
    this.redoStack = [];
    const sheet = activeSheetIndex(doc);
    this.set({
      doc,
      path,
      dirty: false,
      sheet,
      selected: doc.sheets[sheet].rootTopic.id,
      editing: null,
      rev: this.state.rev + 1,
      view: { cmd: 'fit', at: Date.now() },
    });
    if (path) this.remember(path);
    this.updateTitle();
  }

  private remember(path: string) {
    const recent = [path, ...this.state.recent.filter((p) => p !== path)].slice(0, 10);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    this.set({ recent });
  }

  clearRecent() {
    localStorage.setItem(RECENT_KEY, '[]');
    this.set({ recent: [] });
  }

  forget(path: string) {
    const recent = this.state.recent.filter((p) => p !== path);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    this.set({ recent });
  }

  private updateTitle() {
    const { path, doc } = this.state;
    setWindowTitle(doc ? `${path ? baseName(path) : '未命名'} · Naotu` : 'Naotu');
  }

  /** 当前文档有未保存且无路径的修改时，丢弃前先确认 */
  async confirmDiscard(): Promise<boolean> {
    if (!this.state.doc || !this.state.dirty) return true;
    if (this.state.path) {
      await this.save();
      return true;
    }
    return confirm('当前脑图还没有保存，继续会丢失这些修改。', '不保存');
  }

  async newDoc(opts: { markdown?: string; title?: string; skipConfirm?: boolean } = {}) {
    if (!opts.skipConfirm && !(await this.confirmDiscard())) return;
    this.load(opts.markdown ? docFromOutline(opts.markdown, opts.title) : makeDoc(opts.title || '中心主题'), null);
  }

  async openPath(path: string, skipConfirm = false) {
    if (path === this.state.path && this.state.doc) return;
    if (!skipConfirm && !(await this.confirmDiscard())) return;
    const doc = parseXmind(await readFile(path));
    this.savedMtime = await fileMtime(path);
    this.load(doc, path);
  }

  async openDialog() {
    try {
      const p = await pickOpen();
      if (p) await this.openPath(p);
    } catch (e) {
      this.toast(errText(e), 'error');
    }
  }

  async openRecent(path: string) {
    try {
      await this.openPath(path);
    } catch (e) {
      this.toast(errText(e), 'error');
      this.forget(path);
    }
  }

  /** 保存；给 path 即另存为。无路径时弹保存对话框。 */
  async save(path?: string | null): Promise<string | null> {
    const { doc } = this.state;
    if (!doc) return null;
    let target = path ?? this.state.path;
    if (!target) {
      target = await pickSave(`${titleOf(doc.sheets[0].rootTopic) || '未命名'}.xmind`);
      if (!target) return null;
    }
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saving = true;
    const rev = this.state.rev;
    try {
      doc.metadata.activeSheetId = this.sheetObj?.id;
      this.savedMtime = await writeFile(target, serializeXmind(doc));
      const pathChanged = target !== this.state.path;
      this.set({ path: target, dirty: this.state.rev !== rev });
      if (pathChanged) {
        this.remember(target);
        this.updateTitle();
      }
      return target;
    } finally {
      this.saving = false;
    }
  }

  async saveAs() {
    const { doc } = this.state;
    if (!doc) return;
    const p = await pickSave(this.state.path ? baseName(this.state.path) : `${titleOf(doc.sheets[0].rootTopic)}.xmind`);
    if (p) await this.save(p);
  }

  private scheduleSave() {
    if (!this.state.path || !isTauri) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.save().catch((e) => this.toast(`自动保存失败：${errText(e)}`, 'error'));
    }, 500);
  }

  /** 外部程序（xmind CLI、同步盘等）改了文件且本地没有未保存修改时，重新载入 */
  async checkExternal() {
    const { path, dirty, doc } = this.state;
    if (!path || !doc || dirty || this.saving) return;
    let m: number;
    try {
      m = await fileMtime(path);
    } catch {
      return;
    }
    if (m <= this.savedMtime + 1) return;
    try {
      const fresh = parseXmind(await readFile(path));
      this.savedMtime = m;
      const { sheet, selected } = this.state;
      this.undoStack = [];
      this.redoStack = [];
      const si = clampSheet(fresh, sheet);
      const keep = selected && find(fresh.sheets[si].rootTopic, selected) ? selected : fresh.sheets[si].rootTopic.id;
      this.set({ doc: fresh, sheet: si, selected: keep, editing: null, rev: this.state.rev + 1 });
      this.toast('文件在外部被修改，已重新载入');
    } catch {
      // 外部写到一半时可能读到不完整的 zip，下一轮再试
    }
  }

  // ---------- 修改（全部经过这里，保证撤销栈和自动保存） ----------

  private snapshot(): Snapshot {
    return { sheets: structuredClone(this.state.doc!.sheets), sheet: this.state.sheet, selected: this.state.selected };
  }

  apply(fn: (doc: XDoc) => OpResult, source: Source = 'user', describe?: (r: OpResult) => string): OpResult {
    const doc = this.state.doc;
    if (!doc) throw new OpError('当前没有打开的脑图，先 open 或 new');
    const before = this.snapshot();
    let r: OpResult;
    try {
      r = fn(doc);
    } catch (e) {
      doc.sheets = before.sheets;
      throw e;
    }
    if (!r.changed) return r;

    this.undoStack.push(before);
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];

    const sheet = r.sheetIndex ?? this.state.sheet;
    const s = doc.sheets[clampSheet(doc, sheet)];
    const patch: Partial<AppState> = { dirty: true, rev: this.state.rev + 1, sheet };

    if (source === 'user') {
      if (r.select) patch.selected = r.select;
    } else {
      // agent 的修改不抢用户的选中和输入，只高亮 + 提示
      const now = Date.now();
      if (r.touched?.length) {
        patch.flash = { ids: r.touched, at: now };
        patch.reveal = { id: r.touched[0], at: now };
      }
      patch.toast = { text: `AI · ${describe?.(r) ?? '修改了脑图'}`, tone: 'agent', at: now };
    }
    // 选中或正在编辑的主题被删掉时，回落到合理的位置
    const sel = patch.selected ?? this.state.selected;
    if (!sel || !find(s.rootTopic, sel)) patch.selected = r.select && find(s.rootTopic, r.select) ? r.select : s.rootTopic.id;
    if (this.state.editing && !find(s.rootTopic, this.state.editing.id)) patch.editing = null;

    this.set(patch);
    this.scheduleSave();
    return r;
  }

  op(method: string, params: Record<string, unknown>, source: Source = 'user'): OpResult {
    return this.apply((doc) => runOp(doc, method, params, { sheetIndex: this.state.sheet }), source, TOAST_VERB[method]);
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev || !this.state.doc) return;
    this.redoStack.push(this.snapshot());
    this.restore(prev);
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next || !this.state.doc) return;
    this.undoStack.push(this.snapshot());
    this.restore(next);
  }

  private restore(s: Snapshot) {
    this.state.doc!.sheets = s.sheets;
    this.set({ sheet: clampSheet(this.state.doc!, s.sheet), selected: s.selected, editing: null, dirty: true, rev: this.state.rev + 1 });
    this.scheduleSave();
  }

  // ---------- 选择 / 编辑 ----------

  select(id: string | null, reveal = false) {
    this.set({ selected: id, ...(reveal && id ? { reveal: { id, at: Date.now() } } : {}) });
  }

  startEdit(id?: string | null, isNew = false) {
    const target = id ?? this.state.selected;
    if (!target || !this.topic(target)) return;
    this.set({ selected: target, editing: { id: target, isNew }, reveal: { id: target, at: Date.now() } });
  }

  commitEdit(text: string) {
    const e = this.state.editing;
    if (!e) return;
    this.set({ editing: null });
    const t = this.topic(e.id);
    const title = text.trim() ? text.replace(/\s+$/, '') : '';
    if (t && title && title !== titleOf(t)) this.op('update', { id: e.id, title });
  }

  cancelEdit() {
    this.set({ editing: null });
  }

  switchSheet(i: number) {
    const { doc } = this.state;
    if (!doc) return;
    const sheet = clampSheet(doc, i);
    this.set({ sheet, selected: doc.sheets[sheet].rootTopic.id, editing: null, rev: this.state.rev + 1, view: { cmd: 'fit', at: Date.now() } });
  }

  // ---------- 键盘命令 ----------

  private defaultTitle(depth: number) {
    return depth <= 1 ? '分支主题' : '子主题';
  }

  addChild() {
    const s = this.sheetObj;
    if (!s) return;
    const parent = resolve(s, this.state.selected ?? 'root');
    const r = this.op('add', { parent: parent.topic.id, title: this.defaultTitle(parent.depth + 1) });
    this.startEdit(r.select, true);
  }

  addSibling(before = false) {
    const s = this.sheetObj;
    if (!s) return;
    const cur = resolve(s, this.state.selected ?? 'root');
    if (!cur.parent) return this.addChild();
    const r = this.op('add', { parent: cur.parent.id, title: this.defaultTitle(cur.depth), index: before ? cur.index : cur.index + 1 });
    this.startEdit(r.select, true);
  }

  deleteSelected() {
    const s = this.sheetObj;
    const id = this.state.selected;
    if (!s || !id || id === s.rootTopic.id) return;
    this.op('delete', { id });
  }

  toggleFold(id = this.state.selected) {
    const t = this.topic(id);
    if (t && kids(t).length) this.op('fold', { id: t.id });
  }

  reorder(delta: number) {
    const s = this.sheetObj;
    if (!s || !this.state.selected) return;
    const cur = resolve(s, this.state.selected);
    if (!cur.parent) return;
    const index = cur.index + delta;
    if (index < 0 || index >= kids(cur.parent).length) return;
    this.op('move', { id: cur.topic.id, parent: cur.parent.id, index });
  }

  moveTo(id: string, parent: string) {
    try {
      this.op('move', { id, parent });
    } catch (e) {
      this.toast(errText(e), 'error');
    }
  }

  // ---------- 剪贴板 ----------

  copy(): string | null {
    const t = this.topic(this.state.selected);
    if (!t) return null;
    const text = subtreeMarkdown(t);
    this.clip = { text, topic: structuredClone(t) };
    return text;
  }

  paste(text: string) {
    const s = this.sheetObj;
    if (!s || !text.trim()) return;
    const parent = this.state.selected ?? s.rootTopic.id;
    if (this.clip && this.clip.text === text) {
      const copy = cloneWithNewIds(this.clip.topic);
      this.apply((doc) => {
        const p = find(doc.sheets[this.state.sheet].rootTopic, parent);
        if (!p) throw new OpError('粘贴目标不存在');
        attachedOf(p.topic).push(copy);
        return { result: null, changed: true, select: copy.id };
      });
      return;
    }
    // 有大纲符号按大纲解析；纯文本每行一个主题
    if (/^\s*(?:[-*+]|\d+[.)]|#{1,6})\s/m.test(text)) this.op('add_outline', { parent, markdown: text });
    else {
      const titles = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      this.op('add', { parent, titles });
    }
  }

  async focus() {
    await focusWindow();
  }
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const store = new Store();

export function useStore<T>(pick: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => pick(store.get()));
}
