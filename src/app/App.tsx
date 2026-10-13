import { useEffect, useRef, useState } from 'react';
import { layoutKind, noteOf, titleOf } from '../core/model';
import { handleAgent } from './agent';
import { Canvas, layoutRef } from './Canvas';
import { neighbor } from './layout';
import { baseName, isTauri, onCloseRequested, onMenu, serveAgent, syncMenu } from './platform';
import { errText, store, useStore } from './store';

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT');

function toggleLayout() {
  const kind = layoutKind(store.sheetObj!.rootTopic);
  store.op('layout', { layout: kind === 'map' ? 'right' : 'map' });
}

/** 菜单栏命令。除撤销 / 重做外，先让正在输入的标题或备注失焦，把内容提交进文档再执行 */
function runMenu(id: string) {
  const s = store.get();
  const typing = isTyping(document.activeElement);
  const view = (cmd: 'in' | 'out' | 'fit') => store.set({ view: { cmd, at: Date.now() } });
  const actions: Record<string, () => unknown> = {
    new: () => store.newDoc(),
    open: () => store.openDialog(),
    save: () => store.save(),
    save_as: () => store.saveAs(),
    fold: () => store.toggleFold(),
    zoom_in: () => view('in'),
    zoom_out: () => view('out'),
    fit: () => view('fit'),
    layout: toggleLayout,
    notes: () => store.set({ notesOpen: !s.notesOpen }),
    recent_clear: () => store.clearRecent(),
  };
  let fn: (() => unknown) | undefined;
  // 正在输入时，撤销 / 重做作用在输入框里的文字上
  if (id === 'undo') fn = typing ? () => document.execCommand('undo') : () => store.undo();
  else if (id === 'redo') fn = typing ? () => document.execCommand('redo') : () => store.redo();
  else if (id.startsWith('recent:')) fn = () => store.openRecent(id.slice('recent:'.length));
  else fn = actions[id];
  // 没打开脑图时这些项在菜单里是灰的，这里再挡一次
  const needsDoc = !['new', 'open', 'recent_clear'].includes(id) && !id.startsWith('recent:');
  if (!fn || (needsDoc && !s.doc)) return;
  if (typing && id !== 'undo' && id !== 'redo') (document.activeElement as HTMLElement).blur();
  Promise.resolve()
    .then(fn)
    .catch((e) => store.toast(errText(e), 'error'));
}

function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.isComposing) return;
      const s = store.get();
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key;
      const run = (fn: () => void) => {
        e.preventDefault();
        try {
          fn();
        } catch (err) {
          store.toast(errText(err), 'error');
        }
      };

      // 桌面版里 ⌘ 组合键归菜单栏（src-tauri/src/menu.rs），这里只在浏览器预览时处理，避免执行两遍
      if (mod && isTauri && k.toLowerCase() !== 'y') return;
      if (mod && k.toLowerCase() === 'n' && e.shiftKey) return run(() => store.set({ notesOpen: !s.notesOpen }));
      if (mod && k.toLowerCase() === 'n') return run(() => void store.newDoc());
      if (mod && k.toLowerCase() === 'o') return run(() => void store.openDialog());
      if (!s.doc) return;

      if (mod && k.toLowerCase() === 's') return run(() => void (e.shiftKey ? store.saveAs() : store.save()).catch((x) => store.toast(errText(x), 'error')));
      if (mod && k.toLowerCase() === 'z') return run(() => (e.shiftKey ? store.redo() : store.undo()));
      if (mod && k.toLowerCase() === 'y') return run(() => store.redo());
      if (mod && (k === '=' || k === '+')) return run(() => store.set({ view: { cmd: 'in', at: Date.now() } }));
      if (mod && k === '-') return run(() => store.set({ view: { cmd: 'out', at: Date.now() } }));
      if (mod && k === '0') return run(() => store.set({ view: { cmd: 'fit', at: Date.now() } }));
      if (mod && k === '/') return run(() => store.toggleFold());
      if (mod) return;

      if (k === 'Tab') return run(() => store.addChild());
      if (k === 'Enter') return run(() => store.addSibling(e.shiftKey));
      if (k === 'Delete' || k === 'Backspace') return run(() => store.deleteSelected());
      if (k === ' ' || k === 'F2') return run(() => store.startEdit());
      if (k === 'Escape') return run(() => (s.notesOpen ? store.set({ notesOpen: false }) : store.select(null)));
      if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) return run(() => store.reorder(k === 'ArrowUp' ? -1 : 1));
      if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') {
        return run(() => {
          const root = store.sheetObj!.rootTopic.id;
          const cur = s.selected ?? root;
          const next = layoutRef.current && (s.selected ? neighbor(layoutRef.current, cur, k) : root);
          if (next) store.select(next, true);
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// 复制分支 = Markdown 大纲，可以直接贴进任何文本编辑器；反过来贴大纲进来也会变成分支
function useClipboard() {
  useEffect(() => {
    const onCopy = (e: ClipboardEvent, cut = false) => {
      if (isTyping(document.activeElement) || !store.get().doc) return;
      const text = store.copy();
      if (!text) return;
      e.preventDefault();
      e.clipboardData?.setData('text/plain', text);
      if (cut) store.deleteSelected();
    };
    const onCut = (e: ClipboardEvent) => onCopy(e, true);
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(document.activeElement) || !store.get().doc) return;
      const text = e.clipboardData?.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      try {
        store.paste(text);
      } catch (err) {
        store.toast(errText(err), 'error');
      }
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    };
  }, []);
}

function useDesktopIntegration() {
  useEffect(() => {
    // 注册是异步的：effect 若在注册完成前就被清理（StrictMode 会这样），完成后立刻注销，
    // 否则会留下两个监听器，agent 的每个操作被执行两次
    let cancelled = false;
    const stops: (() => void)[] = [];
    const keep = (f: () => void) => (cancelled ? f() : stops.push(f));
    serveAgent(handleAgent).then(keep);
    onMenu(runMenu).then(keep);
    onCloseRequested(async () => {
      if (!store.get().dirty) return true;
      if (store.get().path) {
        await store.save().catch(() => {});
        return true;
      }
      return store.confirmDiscard();
    }).then(keep);
    const timer = isTauri ? setInterval(() => void store.checkExternal(), 2000) : undefined;
    return () => {
      cancelled = true;
      stops.forEach((f) => f());
      clearInterval(timer);
    };
  }, []);
}

export function App() {
  useGlobalKeys();
  useClipboard();
  useDesktopIntegration();
  const hasDoc = useStore((s) => !!s.doc);
  const notesOpen = useStore((s) => s.notesOpen);
  const recent = useStore((s) => s.recent);
  useEffect(() => syncMenu(hasDoc, recent), [hasDoc, recent]);

  return (
    <div className="app">
      <TopBar />
      <main className="main">
        {hasDoc ? <Canvas /> : <Welcome />}
        {hasDoc && notesOpen && <NotesPanel />}
      </main>
      {hasDoc && <BottomBar />}
      <Toast />
    </div>
  );
}

function TopBar() {
  const path = useStore((s) => s.path);
  const dirty = useStore((s) => s.dirty);
  const hasDoc = useStore((s) => !!s.doc);
  const notesOpen = useStore((s) => s.notesOpen);
  useStore((s) => s.rev);
  const kind = hasDoc ? layoutKind(store.sheetObj!.rootTopic) : 'map';

  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="title" data-tauri-drag-region>
        {hasDoc ? (path ? baseName(path).replace(/\.xmind$/i, '') : '未命名') : ''}
        {hasDoc && dirty && !path && <span className="dirty" title="未保存" />}
      </div>
      {hasDoc && (
        <nav className="actions">
          {/* 有路径的文件会自动保存，只有未命名的脑图需要这个入口 */}
          {!path && (
            <button onClick={() => void store.save().catch((e) => store.toast(errText(e), 'error'))} title="保存 ⌘S">
              保存
            </button>
          )}
          <button onClick={toggleLayout} title="切换布局">
            {kind === 'map' ? '地图' : kind === 'right' ? '向右' : '向左'}
          </button>
          <button className={notesOpen ? 'on' : ''} onClick={() => store.set({ notesOpen: !notesOpen })} title="备注 ⇧⌘N">
            备注
          </button>
        </nav>
      )}
    </header>
  );
}

function Welcome() {
  const recent = useStore((s) => s.recent);
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <h1>Naotu</h1>
        <p className="sub">本地脑图，直接读写 .xmind</p>
        <div className="welcome-actions">
          <button className="primary" onClick={() => void store.newDoc()}>
            新建 <kbd>⌘N</kbd>
          </button>
          <button onClick={() => void store.openDialog()} disabled={!isTauri}>
            打开 <kbd>⌘O</kbd>
          </button>
        </div>
        {recent.length > 0 && (
          <ul className="recent">
            {recent.map((p) => (
              <li key={p}>
                <button onClick={() => void store.openRecent(p)} title={p}>
                  <span className="name">{baseName(p).replace(/\.xmind$/i, '')}</span>
                  <span className="dir">{p.replace(/\/[^/]+$/, '').replace(/^\/Users\/[^/]+/, '~')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="hint">AI agent 可在终端用 <code>naotu</code> 命令或 MCP 控制这个窗口</p>
      </div>
    </div>
  );
}

function NotesPanel() {
  const selected = useStore((s) => s.selected);
  useStore((s) => s.rev);
  const topic = store.topic(selected);

  return (
    <aside className="notes">
      <div className="notes-head">
        <span>备注</span>
        <button onClick={() => store.set({ notesOpen: false })} aria-label="关闭">
          ×
        </button>
      </div>
      {topic ? (
        <>
          <div className="notes-topic">{titleOf(topic)}</div>
          {/* 按主题 id 重建编辑器：切换选中时旧编辑器在卸载前把内容存回它自己的主题 */}
          <NoteEditor key={topic.id} id={topic.id} initial={noteOf(topic)} />
        </>
      ) : (
        <div className="notes-empty">选中一个主题</div>
      )}
    </aside>
  );
}

function NoteEditor({ id, initial }: { id: string; initial: string }) {
  const [text, setText] = useState(initial);
  const draft = useRef({ text: initial, dirty: false });

  const commit = () => {
    if (!draft.current.dirty) return;
    draft.current.dirty = false;
    try {
      store.op('update', { id, note: draft.current.text });
    } catch {
      // 主题已被删除
    }
  };
  useEffect(() => commit, []);
  // agent 或撤销改了备注、且用户没在输入时同步
  useEffect(() => {
    if (!draft.current.dirty) {
      draft.current.text = initial;
      setText(initial);
    }
  }, [initial]);

  return (
    <textarea
      value={text}
      placeholder="写点补充说明…"
      onChange={(e) => {
        draft.current = { text: e.target.value, dirty: true };
        setText(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
      }}
    />
  );
}

function BottomBar() {
  const doc = useStore((s) => s.doc)!;
  const sheet = useStore((s) => s.sheet);
  const zoom = useStore((s) => s.zoom);
  useStore((s) => s.rev);
  const [renaming, setRenaming] = useState<number | null>(null);

  return (
    <footer className="bottombar">
      <div className="sheets">
        {doc.sheets.map((s, i) =>
          renaming === i ? (
            <input
              key={s.id}
              className="sheet-input"
              autoFocus
              defaultValue={s.title}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== s.title) store.op('rename_sheet', { sheet: i, title: v });
                setRenaming(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setRenaming(null);
              }}
            />
          ) : (
            <button key={s.id} className={i === sheet ? 'on' : ''} onClick={() => store.switchSheet(i)} onDoubleClick={() => setRenaming(i)}>
              {s.title}
            </button>
          ),
        )}
        <button className="add" onClick={() => store.op('add_sheet', {})} title="新建画布">
          +
        </button>
      </div>
      <button className="zoom" onClick={() => store.set({ view: { cmd: 'fit', at: Date.now() } })} title="适应窗口 ⌘0">
        {Math.round(zoom * 100)}%
      </button>
    </footer>
  );
}

function Toast() {
  const toast = useStore((s) => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), toast.tone === 'error' ? 4000 : 2200);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast) return null;
  return <div className={`toast ${toast.tone}${visible ? ' show' : ''}`}>{toast.text}</div>;
}
