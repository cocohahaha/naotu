import { OpError, resolve, resolveSheet } from '../core/model';
import { DOC_METHODS, runOp } from '../core/ops';
import { focusWindow, type RpcMessage } from './platform';
import { store } from './store';

const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

function needDoc() {
  if (!store.get().doc) throw new OpError('当前没有打开的脑图，先 open 或 new');
}

/** agent 请求入口。文档操作交给 core/ops，这里只处理打开、保存、选中、撤销等应用级动作。 */
export async function handleAgent({ method, params }: RpcMessage): Promise<unknown> {
  switch (method) {
    case 'status':
      return store.status();

    case 'open': {
      const path = str(params.path);
      if (!path) throw new OpError('open 需要 path');
      await store.openPath(path, true);
      if (params.focus !== false) await focusWindow();
      return store.status();
    }

    case 'new': {
      // agent 新建时不弹确认框；当前文档若有路径会先自动保存
      if (store.get().dirty && store.get().path) await store.save();
      await store.newDoc({ markdown: str(params.markdown), title: str(params.title), skipConfirm: true });
      const path = str(params.path);
      if (path) await store.save(path);
      if (params.focus !== false) await focusWindow();
      return store.status();
    }

    case 'save': {
      needDoc();
      const path = str(params.path) ?? store.get().path;
      if (!path) throw new OpError('这是未命名的新脑图，save 需要 path');
      await store.save(path);
      return store.status();
    }

    case 'select': {
      needDoc();
      const id = resolve(store.sheetObj!, str(params.id)).topic.id;
      store.select(id, true);
      return { id };
    }

    case 'switch_sheet': {
      needDoc();
      store.switchSheet(resolveSheet(store.get().doc!, params.sheet, store.get().sheet));
      return store.status();
    }

    case 'undo':
    case 'redo':
      needDoc();
      store[method]();
      return store.status();

    case 'focus':
      await focusWindow();
      return { ok: true };
  }

  if (!(DOC_METHODS as readonly string[]).includes(method)) throw new OpError(`未知操作 "${method}"`);
  needDoc();
  if (method === 'read' || method === 'sheets') {
    return runOp(store.get().doc!, method, params, { sheetIndex: store.get().sheet }).result;
  }
  return store.op(method, params, 'agent').result;
}
