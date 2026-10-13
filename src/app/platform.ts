// 所有和 Tauri 打交道的地方集中在这里。普通浏览器里打开（vite dev）时自动降级：
// 能新建和编辑，不能读写文件，也没有 agent 桥。

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ask, open, save } from '@tauri-apps/plugin-dialog';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const need = () => {
  if (!isTauri) throw new Error('浏览器预览模式不能读写文件，请在 Naotu 桌面版里操作');
};

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export async function readFile(path: string): Promise<Uint8Array> {
  need();
  return fromB64(await invoke<string>('read_file', { path }));
}

/** 返回写入后的 mtime（毫秒），用于区分“自己写的”和“外部改的” */
export async function writeFile(path: string, bytes: Uint8Array): Promise<number> {
  need();
  return invoke<number>('write_file', { path, data: toB64(bytes) });
}

export async function fileMtime(path: string): Promise<number> {
  return invoke<number>('file_mtime', { path });
}

const FILTERS = [{ name: 'XMind', extensions: ['xmind'] }];

export async function pickOpen(): Promise<string | null> {
  need();
  const r = await open({ multiple: false, directory: false, filters: FILTERS });
  return typeof r === 'string' ? r : null;
}

export async function pickSave(defaultName: string): Promise<string | null> {
  need();
  const r = await save({ defaultPath: defaultName, filters: FILTERS });
  if (!r) return null;
  return r.toLowerCase().endsWith('.xmind') ? r : `${r}.xmind`;
}

export async function confirm(message: string, okLabel = '继续'): Promise<boolean> {
  if (!isTauri) return window.confirm(message);
  return ask(message, { title: 'Naotu', kind: 'warning', okLabel, cancelLabel: '取消' });
}

export function setWindowTitle(title: string): void {
  if (isTauri) void getCurrentWindow().setTitle(title);
  else document.title = title;
}

export async function focusWindow(): Promise<void> {
  if (!isTauri) return;
  const w = getCurrentWindow();
  await w.unminimize();
  await w.show();
  await w.setFocus();
}

export interface RpcMessage {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** 注册 agent 请求处理器，注册完成后告诉 Rust 端可以开始转发。 */
export async function serveAgent(handler: (m: RpcMessage) => Promise<unknown>): Promise<() => void> {
  if (!isTauri) return () => {};
  const unlisten = await listen<RpcMessage>('agent-rpc', async (e) => {
    const { id } = e.payload;
    let payload: unknown;
    try {
      payload = { ok: true, result: await handler(e.payload) };
    } catch (err) {
      payload = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    await invoke('agent_reply', { id, payload });
  });
  await invoke('bridge_ready');
  return unlisten;
}

/** 菜单栏命令（含菜单快捷键），payload 是菜单项 id。浏览器预览里没有菜单栏。 */
export async function onMenu(handler: (id: string) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  return listen<string>('menu', (e) => handler(e.payload));
}

/** 按当前状态刷新菜单：没打开脑图时置灰保存等项，重建「打开最近使用」 */
export function syncMenu(hasDoc: boolean, recent: string[]): void {
  if (isTauri) void invoke('sync_menu', { hasDoc, recent });
}

export async function onCloseRequested(handler: () => Promise<boolean>): Promise<() => void> {
  if (!isTauri) return () => {};
  return getCurrentWindow().onCloseRequested(async (e) => {
    if (!(await handler())) e.preventDefault();
  });
}

export const baseName = (p: string) => p.split('/').pop() ?? p;
