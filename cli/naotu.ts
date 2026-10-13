import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { OpError, call, createMap, openInApp, status } from './client';

const HELP = `naotu: 控制本地脑图应用 Naotu（读写 .xmind）

用法: naotu <命令> [参数] [--file <x.xmind>] [--sheet <序号|标题>]

  不加 --file：操作 Naotu 窗口里当前打开的脑图（改动实时显示、可 ⌘Z 撤销）
  加 --file：  该文件正在窗口里打开时走窗口；否则直接改文件，不需要应用运行

查看
  status                         应用是否运行、当前文件、画布、选中主题
  show [--json|--markdown]       输出大纲；每行带 [id:xxxxxxxx]，后续命令用它指代主题
  sheets                         列出画布

打开 / 新建 / 保存
  open <x.xmind>                 在窗口中打开（应用没开会自动启动）
  new [标题] [-o x.xmind] [--from-markdown f.md | --stdin | --text "..."] [--no-app] [--force]
                                 新建脑图；给大纲就一次生成整棵树。--no-app 只写文件
  save [x.xmind]                 保存（未命名文档需给路径）

编辑（<主题> 可以是 id、id 前缀、唯一标题，或 root）
  add <父主题> <标题> [标题2 ...] [--index n] [--note "..."]
  add-outline <父主题> [--stdin | --from-markdown f.md | --text "..."]
  update <主题> [--title t] [--note t] [--labels a,b] [--markers priority-1,star-red] [--href url]
                                 传空字符串表示清除，例如 --note ""
  move <主题> <新父主题> [--index n]
  delete <主题> [主题2 ...]
  fold <主题> | unfold <主题>
  layout map|right|left
  add-sheet [标题] [--from-markdown f.md | --stdin | --text "..."]
  rename-sheet <标题> [--sheet s]

窗口
  select <主题>                  选中并滚动到该主题（给用户指位置）
  switch-sheet <序号|标题>
  undo | redo

MCP
  naotu mcp                      以 stdio 方式运行 MCP server

示例
  naotu new "季度规划" -o ~/Desktop/plan.xmind --text $'- 目标\\n  - 增长\\n- 节奏'
  naotu show
  naotu add root "风险" --note "供应链"
  naotu update 风险 --labels 重要 --markers priority-1
`;

const BOOL = new Set(['json', 'markdown', 'stdin', 'no-app', 'force', 'help']);

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (BOOL.has(a.slice(2))) flags[a.slice(2)] = true;
      else flags[a.slice(2)] = argv[++i] ?? '';
    } else if (a === '-o') flags.output = argv[++i] ?? '';
    else if (a === '-h') flags.help = true;
    else pos.push(a);
  }
  return { pos, flags };
}

function markdownInput(flags: Record<string, string | boolean>): string | undefined {
  if (flags.stdin) return readFileSync(0, 'utf8');
  if (typeof flags['from-markdown'] === 'string') return readFileSync(flags['from-markdown'], 'utf8');
  if (typeof flags.text === 'string') return flags.text;
  return undefined;
}

const out = (v: unknown) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || flags.help) return out(HELP);

  const file = typeof flags.file === 'string' ? flags.file : undefined;
  const base: Record<string, unknown> = {};
  if (flags.sheet !== undefined) base.sheet = flags.sheet;
  const opt = (k: string) => (flags[k] === undefined ? undefined : String(flags[k]));
  const need = (v: string | undefined, what: string) => {
    if (v === undefined || v === '') throw new OpError(`缺少参数：${what}（naotu help 查看用法）`);
    return v;
  };
  const idx = flags.index === undefined ? undefined : Number(flags.index);

  switch (cmd) {
    case 'status':
      return out(await status());
    case 'open':
      return out(await openInApp(need(pos[0], '文件路径')));
    case 'new':
      return out(
        await createMap({
          title: pos[0],
          markdown: markdownInput(flags),
          path: opt('output'),
          app: !flags['no-app'],
          force: !!flags.force,
        }),
      );
    case 'save':
      return out(await call('save', { path: pos[0] ? resolve(pos[0]) : undefined }));
    case 'show':
    case 'read':
      return out(await call('read', { ...base, format: flags.json ? 'json' : flags.markdown ? 'markdown' : 'outline' }, file));
    case 'sheets':
      return out(await call('sheets', base, file));
    case 'add':
      return out(await call('add', { ...base, parent: need(pos[0], '父主题'), titles: pos.slice(1).length ? pos.slice(1) : need(undefined, '标题'), index: idx, note: opt('note') }, file));
    case 'add-outline':
      return out(await call('add_outline', { ...base, parent: need(pos[0], '父主题'), markdown: need(markdownInput(flags), '--stdin / --from-markdown / --text'), index: idx }, file));
    case 'update':
      return out(
        await call(
          'update',
          { ...base, id: need(pos[0], '主题'), title: opt('title'), note: opt('note'), labels: opt('labels'), markers: opt('markers'), href: opt('href') },
          file,
        ),
      );
    case 'move':
      return out(await call('move', { ...base, id: need(pos[0], '主题'), parent: need(pos[1], '新父主题'), index: idx }, file));
    case 'delete':
      if (!pos.length) need(undefined, '主题');
      return out(await call('delete', { ...base, ids: pos }, file));
    case 'fold':
    case 'unfold':
      return out(await call('fold', { ...base, id: need(pos[0], '主题'), folded: cmd === 'fold' }, file));
    case 'layout':
      return out(await call('layout', { ...base, layout: need(pos[0], 'map|right|left') }, file));
    case 'add-sheet':
      return out(await call('add_sheet', { title: pos[0], markdown: markdownInput(flags) }, file));
    case 'rename-sheet':
      return out(await call('rename_sheet', { ...base, title: need(pos[0], '标题') }, file));
    case 'select':
      return out(await call('select', { ...base, id: need(pos[0], '主题') }));
    case 'switch-sheet':
      return out(await call('switch_sheet', { sheet: need(pos[0], '画布') }));
    case 'undo':
    case 'redo':
      return out(await call(cmd, {}));
    case 'mcp':
      await import(new URL('./mcp.mjs', import.meta.url).href);
      return;
  }
  throw new OpError(`未知命令 "${cmd}"（naotu help 查看用法）`);
}

main().catch((e) => {
  console.error(`naotu: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
