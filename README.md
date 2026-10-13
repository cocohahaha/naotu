# Naotu

本地脑图应用。直接读写标准 `.xmind` 文件，和 XMind、官方 xmind CLI 互通；AI agent 可以通过 `naotu` 命令或 MCP 实时操控窗口里的脑图。不联网，没有账号和云服务。

技术栈：Tauri 2（Rust 外壳）+ React 19 + TypeScript，脑图用 SVG 自绘。

## 目录

```
src/core/      纯 TS 的文档层：.xmind 读写、增删改查、Markdown 大纲互转（应用和 CLI 共用）
src/app/       界面：store（撤销/自动保存）、layout（排版）、Canvas（渲染与交互）、agent（远程调用入口）
src-tauri/     Rust：文件读写、系统对话框、本机 agent 桥（127.0.0.1 随机端口 + token）
cli/           naotu 命令行与 MCP server
test/          core 单元测试（含官方 xmind validate 校验）
scripts/       CLI 打包、界面冒烟测试
```

## 构建与安装

```bash
npm install
npm run app:build          # 产出 ~/Library/Caches/naotu-target/release/bundle/macos/Naotu.app
npm run build:cli          # 产出 dist-cli/naotu.mjs 和 dist-cli/mcp.mjs
npm link                   # 把 naotu / naotu-mcp 命令装到 PATH
```

Rust 编译产物放在 `~/Library/Caches/naotu-target`，不进文稿目录；crates 走 rsproxy 镜像，配置在 `src-tauri/.cargo/config.toml`，只影响本项目。

第一次从「文稿」「桌面」打开文件时，macOS 会弹出一次文件夹访问授权，点允许即可。

## 快捷键

| 操作 | 按键 |
| --- | --- |
| 新增子主题 / 同级主题 / 在前面插入同级 | Tab / Enter / Shift+Enter |
| 编辑主题 | Space、F2 或双击；编辑中 Enter 完成，Shift+Enter 换行，Tab 完成并新增子主题，Esc 取消 |
| 删除 | Delete / Backspace |
| 移动选中 | 方向键（按空间方向，左侧分支里 ← 是进入下一级） |
| 调整同级顺序 | Option+↑ / Option+↓ |
| 改父主题 | 拖动主题放到另一个主题上 |
| 折叠 / 展开 | ⌘/ 或点主题旁的小圆点 |
| 复制 / 剪切 / 粘贴分支 | ⌘C / ⌘X / ⌘V（剪贴板里是 Markdown 大纲，可以从别处贴大纲进来） |
| 撤销 / 重做 | ⌘Z / ⇧⌘Z |
| 新建 / 打开 / 保存 / 另存为 | ⌘N / ⌘O / ⌘S / ⇧⌘S |
| 备注面板 | ⇧⌘N |
| 缩放 / 适应窗口 | ⌘= ⌘- / ⌘0，触控板捏合缩放、双指平移 |

有路径的文件改动后 0.5 秒自动保存。文件被外部程序修改（例如 xmind CLI）且本地没有未保存改动时，会自动重新载入。

## 让 AI agent 控制

### 命令行（Claude Code、Codex 等能跑 shell 的 agent）

```bash
naotu help                                   # 完整用法
naotu new "季度规划" -o ~/Desktop/plan.xmind --text $'- 目标\n  - 增长\n- 节奏'
naotu show                                   # 大纲，每行带 [id:xxxxxxxx]
naotu add root "风险" --note "供应链"
naotu update 风险 --labels 重要 --markers priority-1
naotu add-outline 风险 --stdin < risks.md
naotu select 风险                            # 在窗口里选中并滚动过去，给用户指位置
```

主题可以用完整 id、id 前缀（≥4 位）、唯一标题或 `root` 指代；标题重名时会报错并列出候选 id，不会静默选错。

- 不加 `--file`：操作窗口里当前打开的脑图，改动实时出现、带高亮提示，用户可以 ⌘Z 撤销。
- 加 `--file x.xmind`：这个文件正在窗口里打开就走窗口；否则直接改文件，应用不用开。

### MCP（Claude Desktop、Hermes 等）

```bash
claude mcp add naotu -s user -- naotu-mcp     # Claude Code
```

其他客户端把命令配置成 `naotu-mcp`（或 `node <项目路径>/dist-cli/mcp.mjs`）即可。工具有 `naotu_status / read / new / open / add / add_outline / update / move / delete / fold / layout / sheets / add_sheet / select / undo / save`。

### 安全

agent 桥只监听 127.0.0.1 的随机端口，token 写在 `~/.naotu/bridge.json`（权限 600）。带 `Origin` 头的请求（也就是浏览器里网页发起的请求）一律拒绝，所以网页无法借这个端口改你的脑图。

## 和 XMind 的兼容范围

- 读写 XMind 2020 及以后的格式（zip + content.json）。XMind 8 的旧格式（content.xml）会提示先在 XMind 里另存。
- 支持并显示：标题、多画布、折叠、备注、标签、标记（优先级、星标、旗帜、任务等）、链接、地图 / 向右 / 向左布局。
- 不显示但原样保留：主题样式、主题皮肤、关系线、概要、外框、自由主题、图片附件。保存时这些字段一个都不会丢。
- 组织结构图、鱼骨图、时间轴等其他结构，会按地图布局显示，文件里的结构设置保持不变。

## 开发

```bash
npm run app:dev            # 带热更新的桌面窗口
npm test                   # core 单测（装了 xmind CLI 时会跑官方校验）
npm run typecheck
python3 scripts/ui_smoke.py /tmp/shots    # 先 npx vite --port 1420；用 WebKit 模拟键盘建图并截图
```
