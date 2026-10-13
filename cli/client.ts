// CLI 和 MCP 共用的连接层。
// 应用在运行 → 经本机 HTTP 桥发给窗口执行（用户实时看到变化、可撤销）；
// 没运行且指定了文件 → 用同一份 core 代码直接改 .xmind。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { OpError, activeSheetIndex, type XDoc } from '../src/core/model';
import { DOC_METHODS, docFromOutline, runOp } from '../src/core/ops';
import { parseXmind, serializeXmind } from '../src/core/xmind';

export { OpError };

interface Bridge {
  port: number;
  token: string;
  pid: number;
}

const BRIDGE_FILE = join(homedir(), '.naotu', 'bridge.json');

function readBridge(): Bridge | null {
  try {
    return JSON.parse(readFileSync(BRIDGE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export async function post(b: Bridge, method: string, params: Record<string, unknown> = {}, timeoutMs = 65000): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${b.port}/rpc`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await res.json()) as { ok: boolean; result?: unknown; error?: string };
  if (!body.ok) throw new OpError(body.error ?? `HTTP ${res.status}`);
  return body.result;
}

/** 应用正在运行且界面已就绪时返回连接信息 */
export async function connect(): Promise<Bridge | null> {
  const b = readBridge();
  if (!b) return null;
  try {
    const r = await post(b, 'ping', {}, 1500);
    return r?.ready ? b : null;
  } catch {
    return null;
  }
}

function findApp(): string | null {
  const candidates = [
    process.env.NAOTU_APP,
    join(homedir(), 'Applications', 'Naotu.app'),
    '/Applications/Naotu.app',
    join(homedir(), 'Library', 'Caches', 'naotu-target', 'release', 'bundle', 'macos', 'Naotu.app'),
  ];
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null;
}

export async function ensureApp(): Promise<Bridge> {
  const live = await connect();
  if (live) return live;
  const app = findApp();
  if (!app) throw new OpError('找不到 Naotu.app。先在项目目录运行 npm run app:build，或用 NAOTU_APP 指定路径');
  spawn('open', [app], { stdio: 'ignore', detached: true }).unref();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const b = await connect();
    if (b) return b;
  }
  throw new OpError('Naotu 启动超时（20 秒）');
}

const real = (p: string) => {
  const abs = resolve(p);
  return existsSync(abs) ? realpathSync(abs) : abs;
};

export function readDoc(path: string): XDoc {
  return parseXmind(new Uint8Array(readFileSync(path)));
}

export function writeDoc(path: string, doc: XDoc): void {
  const tmp = join(dirname(path), `.${basename(path)}.naotu-tmp`);
  writeFileSync(tmp, serializeXmind(doc));
  renameSync(tmp, path);
}

/**
 * 执行一次操作。file 为空 → 作用于窗口当前文档；
 * file 有值且正好是窗口里打开的那个 → 仍走窗口；否则离线直接改文件。
 */
export async function call(method: string, params: Record<string, unknown>, file?: string): Promise<unknown> {
  const b = await connect();
  if (file) {
    const abs = real(file);
    if (b) {
      const st = await post(b, 'status');
      if (st?.file && real(st.file) === abs) return post(b, method, params);
    }
    if (!(DOC_METHODS as readonly string[]).includes(method)) throw new OpError(`${method} 只能作用于 Naotu 窗口里打开的脑图`);
    if (!existsSync(abs)) throw new OpError(`文件不存在：${abs}`);
    const doc = readDoc(abs);
    const r = runOp(doc, method, params, { sheetIndex: activeSheetIndex(doc) });
    if (r.changed) writeDoc(abs, doc);
    return r.result;
  }
  if (!b) throw new OpError('Naotu 没有在运行。用 naotu open <文件> 或 naotu new 启动它，或者加 --file 直接改文件');
  return post(b, method, params);
}

export async function status(): Promise<unknown> {
  const b = await connect();
  return b ? post(b, 'status') : { app: 'naotu', running: false };
}

export async function openInApp(file: string): Promise<unknown> {
  const abs = real(file);
  if (!existsSync(abs)) throw new OpError(`文件不存在：${abs}`);
  return post(await ensureApp(), 'open', { path: abs });
}

export interface NewOptions {
  title?: string;
  markdown?: string;
  path?: string;
  /** false：不启动应用，只写文件（需要 path） */
  app?: boolean;
  force?: boolean;
}

export async function createMap(o: NewOptions): Promise<unknown> {
  const path = o.path ? resolve(o.path) : undefined;
  if (path && !path.toLowerCase().endsWith('.xmind')) throw new OpError('文件名需要以 .xmind 结尾');
  if (path && existsSync(path) && !o.force) throw new OpError(`文件已存在：${path}（确认覆盖请加 --force）`);
  if (o.app === false) {
    if (!path) throw new OpError('不启动应用时必须给出输出路径');
    writeDoc(path, docFromOutline(o.markdown, o.title));
    return { file: path };
  }
  return post(await ensureApp(), 'new', { title: o.title, markdown: o.markdown, path });
}
