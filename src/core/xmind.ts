import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { OpError, type Sheet, type XDoc } from './model';

const CORE = new Set(['content.json', 'metadata.json', 'manifest.json']);

export function parseXmind(bytes: Uint8Array): XDoc {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new OpError('不是有效的 .xmind 文件（无法解压）');
  }
  const content = files['content.json'];
  if (!content) {
    if (files['content.xml']) throw new OpError('这是 XMind 8 的旧格式（content.xml），请先在 XMind 里另存为新格式');
    throw new OpError('.xmind 文件里缺少 content.json');
  }
  const sheets = JSON.parse(strFromU8(content)) as Sheet[];
  if (!Array.isArray(sheets) || !sheets.length || !sheets[0].rootTopic) throw new OpError('content.json 结构不符合 XMind 格式');
  const metadata = files['metadata.json'] ? JSON.parse(strFromU8(files['metadata.json'])) : {};
  const extra: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(files)) if (!CORE.has(name) && !name.endsWith('/')) extra[name] = data;
  return { sheets, metadata, extra };
}

export function serializeXmind(doc: XDoc): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    'content.json': strToU8(JSON.stringify(doc.sheets)),
    'metadata.json': strToU8(JSON.stringify(doc.metadata)),
    ...doc.extra,
  };
  const manifest = { 'file-entries': Object.fromEntries(Object.keys(entries).map((k) => [k, {}])) };
  entries['manifest.json'] = strToU8(JSON.stringify(manifest));
  return zipSync(entries, { level: 6 });
}
