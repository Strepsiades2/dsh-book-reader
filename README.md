# dsh-book-reader

Read books and papers in DSH: a reading toolbar on the official PDF preview, plus three PDF tools for the model.

**English** | [中文](#中文说明)

## Features

**Reading toolbar** — appears only on `.pdf` previews in the right sidebar; the stock previewer (zoom, selection, reload) is untouched.

- Previous/next page, a page readout that follows scrolling, and a jump box that accepts printed page numbers (or `p152` for PDF page 152).
- Full-text search panel (`Cmd/Ctrl+Shift+F`): click a result to jump there, or insert its page reference into the chat.
- **Insert page reference** (manual): puts `[PDF p.132]` into the composer as plain text at the caret, only when you click it — one undoable edit, your draft is preserved.
- **AI position hint** (on by default): before a turn starts, the model may receive one short line with the page you are reading — at most once per turn, and only when the page changed since the last hint. Turn it off and the model only learns your page when you insert a reference yourself.
- Every control has a hover/focus explanation in English or Chinese, following the DSH UI language.

**Model tools** — the model can look up the page map, search the text, or read chosen pages (as text or as page images) when you ask about a PDF.

| Tool | What it does |
| --- | --- |
| `pdf_info` | Page count, printed↔physical page offset, outline/TOC. Text only. |
| `pdf_search` | Literal full-text search; returns page numbers and snippets. |
| `pdf_read_pages` | Text of chosen pages, optionally as images (`include_image: false` for text only; images cost ~350–1024 tokens/page). |

Typical loop: `pdf_info` → `pdf_search` → `pdf_read_pages` (text) → images only for formulas, diagrams, or tables.

## Install

- **From npm**: DSH **Plugins → Add plugin** → `dsh-book-reader` (or pin `dsh-book-reader@0.1.1`), or `dsh plugin add dsh-book-reader`.
- A fresh install applies live (this profile has HMR); **upgrading a plugin that is already loaded needs a DSH restart** to load the new code.
- **Optional skill** (gives the model the built-in PDF reading guide): symlink the package into the workspace:
  ```sh
  ln -sfn "<installed package dir>" "<workspace>/.dsh/skills/pdf-reader"
  ```
- **Local checkout**: `dsh plugin add "/abs/path/to/dsh-book-reader"`; keep the checkout and its `node_modules/` in place.

## Configuration

Every option is optional and the defaults are safe. Common ones: `maxPagesPerCall` (default 4), `defaultScale` (2.5), `autoShare` (automatic position hint), `allowOutsideWorkspace` (tools stay inside the session workspace by default), `routeAllowedRoots` (restrict the local HTTP routes). The full list with defaults is commented in [`cordis.patch.yml`](cordis.patch.yml).

## Notes

- HTTP routes are loopback-only and unauthenticated; the tools are workspace-scoped by default. Other local preview plugins make the same tradeoff.
- Works only with the official PDF preview: it relies on that preview's DOM markers, which a DSH upgrade may change.
- Scanned PDFs have no text layer — there is no OCR, so only page images help.
- `pdfjs-dist` is pinned to `6.3.289` to match the host process.

## More

- [`SKILL.md`](SKILL.md) — model-facing guide: costs, page numbering, pitfalls.
- [`CHANGELOG.md`](CHANGELOG.md) · [`LICENSE`](LICENSE) (MIT)

---

## 中文说明

在 DSH 里读 PDF 书和论文：官方 PDF 预览上加一条读书工具栏，外加三个 PDF 工具给模型。

### 功能

**阅读工具栏** —— 只在右侧栏的 `.pdf` 预览上出现；不替换官方预览器（缩放、选中、刷新都保持原样）。

- 上一页/下一页、随滚动更新的页码读数、跳页框（输入印刷页码，或 `p152` 表示 PDF 第 152 页）。
- 全文搜索面板（`Cmd/Ctrl+Shift+F`）：点结果跳页，或把该页引用插入对话框。
- **插入当前页引用**（手动）：点一下才把 `[PDF p.132]` 以纯文本插到输入框光标处 —— 一次可撤销的编辑，不会覆盖草稿。
- **AI 位置提示**（默认开）：每轮对话开始时，模型可能收到一行“你正在看第 N 页”的短提示 —— 每轮最多一次，且页码变了才发。关掉后，模型只会通过你自己插入的引用知道页码。
- 每个控件都有 hover / 键盘聚焦提示，跟随 DSH 界面语言（中文或英文）。

**模型工具** —— 默认只花文本 token，图片是按需付的钱。

| 工具 | 作用 |
| --- | --- |
| `pdf_info` | 页数、印刷页↔物理页偏移、目录/TOC；纯文本。 |
| `pdf_search` | 字面全文搜索；返回页码和摘要。 |
| `pdf_read_pages` | 选中页的文本，也可返回页面图片（`include_image: false` 只取文本；图片约 350–1024 token/页）。 |

典型流程：`pdf_info` → `pdf_search` → `pdf_read_pages`（文本）→ 只有公式、图表、表格才看图。

### 安装

- **从 npm 安装**：DSH **Plugins → Add plugin** → 输入 `dsh-book-reader`（或锁定版本 `dsh-book-reader@0.1.1`），或命令行 `dsh plugin add dsh-book-reader`。
- 全新安装即时生效（本 profile 已启用 HMR）；**升级已加载的插件需要完整重启 DSH** 才能加载新代码。
- **可选 skill**（给模型一份内置的 PDF 阅读指南）：把包目录软链到工作区：
  ```sh
  ln -sfn "<已安装的包目录>" "<workspace>/.dsh/skills/pdf-reader"
  ```
- **本地开发**：`dsh plugin add "/abs/path/to/dsh-book-reader"`；源码目录和 `node_modules/` 必须留在原处。

### 配置

全部可选，默认值即安全值。常用：`maxPagesPerCall`（默认 4）、`defaultScale`（2.5）、`autoShare`（自动位置提示）、`allowOutsideWorkspace`（工具默认只读会话工作区）、`routeAllowedRoots`（限制本地 HTTP 路由）。完整键和默认值见 [`cordis.patch.yml`](cordis.patch.yml) 注释。

### 说明

- HTTP 路由只认回环地址且无鉴权；工具默认只在工作区内。其他本地预览插件也是同样的权衡。
- 只支持官方 PDF 预览（依赖它的私有 DOM 标记，DSH 升级可能失效）。
- 扫描件没有文本层，**没有 OCR**，只能看图。
- `pdfjs-dist` 锁定 `6.3.289`，以和宿主进程保持一致。

### 更多

- [`SKILL.md`](SKILL.md) —— 模型使用手册：成本、页码、常见陷阱。
- [`CHANGELOG.md`](CHANGELOG.md) · [`LICENSE`](LICENSE)（MIT）
