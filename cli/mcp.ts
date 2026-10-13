import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'node:path';
import { z } from 'zod';
import { call, createMap, openInApp, status } from './client';

const INSTRUCTIONS = `Naotu 是用户本机的脑图应用，文件是标准 .xmind。
工作方式：先 naotu_read 拿到带 [id:xxxxxxxx] 的大纲，再用这些 id（或唯一标题）做增删改。
不传 file 时操作窗口里当前打开的脑图，用户会实时看到改动并能撤销；传 file 时若该文件没在窗口里打开，则直接改文件。
一次加多层结构优先用 naotu_add_outline（Markdown 列表），比逐个 naotu_add 快且只占一步撤销。`;

const server = new McpServer({ name: 'naotu', version: '0.1.0' }, { instructions: INSTRUCTIONS });

const file = z.string().optional().describe('.xmind 绝对路径。省略 = 窗口里当前打开的脑图');
const sheet = z.union([z.number(), z.string()]).optional().describe('画布序号（从 0 开始）或标题，省略 = 当前画布');
const ref = (what: string) => z.string().describe(`${what}：id、id 前缀（≥4 位）、唯一标题，或 "root"`);

type Handler = (args: any) => Promise<unknown>;

function tool(name: string, description: string, shape: z.ZodRawShape, run: Handler, readOnly = false) {
  server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: readOnly } }, async (args: any) => {
    try {
      const r = await run(args);
      return { content: [{ type: 'text' as const, text: typeof r === 'string' ? r : JSON.stringify(r, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] };
    }
  });
}

const strip = ({ file: _f, ...rest }: Record<string, unknown>) => rest;

tool('naotu_status', '查看 Naotu 是否在运行、当前打开的文件、画布列表和用户选中的主题', {}, () => status(), true);

tool('naotu_open', '在 Naotu 窗口中打开 .xmind 文件（应用未运行会自动启动）', { path: z.string().describe('.xmind 路径') }, (a) => openInApp(a.path));

tool(
  'naotu_new',
  '新建脑图。给 markdown 大纲可一次生成整棵树：只有一个顶层条目时它就是中心主题。默认在窗口中打开',
  {
    title: z.string().optional().describe('中心主题'),
    markdown: z.string().optional().describe('Markdown 大纲（# 标题或 - 列表，缩进表示层级）'),
    path: z.string().optional().describe('保存路径（.xmind）'),
    open_in_app: z.boolean().optional().describe('false = 不启动应用，只写文件（此时必须给 path）'),
    overwrite: z.boolean().optional().describe('path 已存在时是否覆盖'),
  },
  (a) => createMap({ title: a.title, markdown: a.markdown, path: a.path, app: a.open_in_app !== false, force: a.overwrite }),
);

tool(
  'naotu_read',
  '读取脑图。outline（默认）每行带 [id:xxxxxxxx] 以及标签、标记、备注；json 返回完整树；markdown 不带 id',
  { file, sheet, format: z.enum(['outline', 'json', 'markdown']).optional() },
  (a) => call('read', strip(a), a.file),
  true,
);

tool('naotu_sheets', '列出所有画布', { file }, (a) => call('sheets', {}, a.file), true);

tool(
  'naotu_add',
  '在父主题下添加一个或多个同级子主题，返回新 id',
  { parent: ref('父主题'), titles: z.array(z.string()).min(1), index: z.number().int().optional().describe('插入位置，省略追加到末尾'), note: z.string().optional().describe('备注（仅添加一个时生效）'), file, sheet },
  (a) => call('add', strip(a), a.file),
);

tool(
  'naotu_add_outline',
  '把 Markdown 大纲作为子树插到父主题下，适合一次加多层结构',
  { parent: ref('父主题'), markdown: z.string(), index: z.number().int().optional(), file, sheet },
  (a) => call('add_outline', strip(a), a.file),
);

tool(
  'naotu_update',
  '修改主题。只改传入的字段；note 或 href 传空字符串表示清除，labels/markers 传空数组表示清除。markers 例：priority-1、star-red、flag-green、task-done',
  {
    id: ref('主题'),
    title: z.string().optional(),
    note: z.string().optional(),
    labels: z.array(z.string()).optional(),
    markers: z.array(z.string()).optional(),
    href: z.string().optional(),
    file,
    sheet,
  },
  (a) => call('update', strip(a), a.file),
);

tool('naotu_move', '把主题（连同子树）移到新的父主题下', { id: ref('主题'), parent: ref('新父主题'), index: z.number().int().optional(), file, sheet }, (a) =>
  call('move', strip(a), a.file),
);

tool('naotu_delete', '删除主题及其子树', { ids: z.array(z.string()).min(1).describe('主题引用列表'), file, sheet }, (a) => call('delete', strip(a), a.file));

tool('naotu_fold', '折叠或展开分支', { id: ref('主题'), folded: z.boolean(), file, sheet }, (a) => call('fold', strip(a), a.file));

tool('naotu_layout', '切换结构：map（左右展开）、right（向右逻辑图）、left', { layout: z.enum(['map', 'right', 'left']), file, sheet }, (a) =>
  call('layout', strip(a), a.file),
);

tool('naotu_add_sheet', '新增画布，可附带 Markdown 大纲', { title: z.string().optional(), markdown: z.string().optional(), file }, (a) =>
  call('add_sheet', strip(a), a.file),
);

tool('naotu_select', '在窗口中选中并滚动到某主题，用来给用户指位置', { id: ref('主题'), sheet }, (a) => call('select', a));

tool('naotu_undo', '撤销窗口里的上一步操作', {}, () => call('undo', {}));

tool('naotu_save', '保存窗口里的脑图；未命名文档需要 path。已有路径的文档会自动保存，一般不必调用', { path: z.string().optional() }, (a) =>
  call('save', { path: a.path ? resolve(a.path) : undefined }),
);

await server.connect(new StdioServerTransport());
