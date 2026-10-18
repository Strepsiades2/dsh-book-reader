# dsh-book-reader

Read books and papers in DSH: page-aware controls on the official PDF preview, plus cheap, text-first PDF tools for the model.

**English** | [中文](#中文说明)

## Overview

`dsh-book-reader` decorates the official PDF preview in DSH's right sidebar with a small reading toolbar and registers four tools the model can call to read a PDF **text first**. It does not replace the previewer: zoom, fit-to-width, text selection, reload, and auto-refresh keep working, and removing the plugin restores the stock preview.

Controls are attached only to previews whose `absolutePath` ends in `.pdf`. PDFs are parsed and rendered in-process with `pdfjs-dist` + `@napi-rs/canvas`; the browser half adds its controls to the preview's document-header slot.

```
┌─ official PDF preview (PDF.js) ──────────────────────────┐
│ reload  zoom …  │  ‹  ›  [132] / 410   ⌕   ↗   AI●      │  ← added by this plugin
├──────────────────────────────────────────────────────────┤
│ page content …                                           │
└──────────────────────────────────────────────────────────┘
```

Design rule: **spend text tokens by default. Images are a deliberate expense, not the first move.**

### Features

| Control | Behavior |
| --- | --- |
| `‹` / `›` | Previous / next **physical** PDF page (consecutive pages, regardless of printed labels). |
| `[132] / 410` | Current-page readout that follows scrolling; the box is also a jump box (type a page and press `Enter`). Shows the printed page when an offset is known, otherwise the physical page. |
| `⌕` | Opens the full-text search panel. Results read `p.132 — snippet`; click one to jump. Each row also has **`→ AI`**, which inserts `PDF p.132: <snippet>` at the composer caret. |
| `↗` | Inserts `[PDF p.132]` at the composer caret as one undoable edit; it does not overwrite the draft. |
| `AI` + dot | Reading-position reporting toggle (on by default). Dot: green = Host acknowledged, amber = sending, red = Host route failed, faded = off. Shared by all mounted PDF previews and not persisted across reloads. |
| `Cmd/Ctrl + Shift + F` | Opens the search panel for the preview the pointer last claimed, and focuses/selects the query. `Cmd/Ctrl + F` is deliberately not intercepted. |

`Esc` closes the panel; `Enter` in the page box jumps; `Enter` in the search box jumps to the first result. Tooltips explain every control on hover or keyboard focus, in the active DSH UI language (English or Chinese).

After the readout resolves, the browser reports page changes to the Host with a 400 ms trailing debounce. When auto-share is enabled, the Host may inject at most one short, source-attributed position line per step (and, with the default interval, at most one every 3 minutes):

```text
[dsh-pdf-reader] 正在阅读《book》printed 132 (PDF 152) · Chapter 5 › 5B
```

That line is a **position marker only**; it does not tell the model to read anything. The model decides whether, what, and how to read, and can ask again with `pdf_current_page`. Injection is throttled by page change, a minimum interval (3 minutes by default), and step distance.

### Install

#### a) Published package

Install from the DSH **Plugins** page: **Add plugin** → `dsh-book-reader` (or pin the version with `dsh-book-reader@0.1.0`). The CLI equivalent is:

```sh
dsh plugin --profile <name> add dsh-book-reader
```

Restart DSH afterwards; the host half is loaded at startup. With the published package, consumers need **no manual package symlink and no npm command** — the optional skill registration in (c) is the only manual step.

#### b) Local development checkout

```sh
dsh plugin add "/abs/path/to/dsh-book-reader"
# add --profile <name> after "plugin" when targeting a non-default profile
```

Restart DSH after installing. The profile stores a `link:` to the checkout, so keep the checkout **and its `node_modules/`** in place: at runtime the Host imports `pdfjs-dist` and `@napi-rs/canvas` from that directory. The `node_modules/` in this checkout is macOS arm64; on another architecture run `npm install` in the checkout first. `engines.node` requires Node >= 20.

Uninstall either way with `dsh plugin --profile <name> remove dsh-book-reader`, then restart DSH. Prefer enabling the plugin through the GUI toggle over hand-editing `dsh.profile.bundles`; if a profile fails to start after installing, remove the plugin row from the command line and restart.

#### c) Skill registration

```sh
mkdir -p "<workspace>/.dsh/skills"
ln -sfn "/abs/path/to/dsh-book-reader" "<workspace>/.dsh/skills/pdf-reader"
```

The package ships `SKILL.md`, but DSH packaging does **not** auto-register skills. The link name must be `pdf-reader` (the `name` in `SKILL.md`); for an npm-installed package, point it at the installed package directory. The tools work without the skill, but the skill gives the model the text-first loop, the token costs, and the pitfalls. Register it once per workspace.

After publishing, installing the plugin by package name needs no manual symlink and no npm command for consumers; only this optional skill registration remains manual.

### Tools

Four tools, three cost tiers. The default is text.

| Tool | Cost | Use for |
| --- | --- | --- |
| `pdf_info` | ~0 (text) | Page count, printed↔physical offset, outline/TOC; also title, author, file size, page size, and `textCoverage.isLikelyScanned`. |
| `pdf_search` | ~0 (text) | Locating a phrase, theorem number, or figure caption. |
| `pdf_read_pages` + `include_image: false` | ~0 (text, per page) | Prose, theorem statements, exercise text. |
| `pdf_read_pages` (images on) | **~350–1024 tokens/page** | Formulas, diagrams, tables, layout. |
| `pdf_current_page` | ~0 | Which page and section the user is looking at. |

`pdf_read_pages` is the only image-returning tool. It is registered only while `ctx.attachments` is mounted (so PNGs can become durable image attachments), and every call fails if the routed model does not declare image input — even with `include_image: false`.

Page numbers are **1-based**, and relative paths resolve against the session working directory. `pages` accepts `"132-134"`, `"132,135"`, `132`, `[132,133,134]`, or an array of range strings. Other useful arguments:

- `page_numbers`: `"printed"` or `"pdf"`; defaults to printed when the PDF exposes numeric labels/offset.
- `scale`: `1`–`3`, default `2.5` (about 180 DPI).
- `crop`: fractions with a top-left origin — `"x0,y0,x1,y1"`, `[x0,y0,x1,y1]`, or `{x,y,w,h}`.
- `image_quality`: `"cheap"` (1.5×, about 350 tokens/page) or `"standard"` (`defaultScale`).
- `include_image`: default `true`; `false` returns page text only and adds no image tokens.
- `include_text`: default `true`, capped by `maxTextCharsPerPage`.

A call is capped at `maxPagesPerCall` (default **4**, hard maximum **8**) **before** rendering. Exceeding it is an error; pages are never silently dropped. `pdf_read_pages` returns per-page `tokens` and a total `imageTokens`, plus `text`, `textTruncated`, and `textUnavailable` per page. `pdf_info` caps its outline at 200 entries, and `pdf_search` defaults to 20 hits (clamped to `maxSearchResults`).

#### Text-first loop

1. `pdf_info` once per document. Note `printedOffset`, `pageNumberMode`, and the outline. Never hardcode the offset.
2. `pdf_search` for a distinctive phrase to get physical page numbers.
3. `pdf_read_pages` with **`include_image: false`** to read those pages as text.
4. Only when the text is ambiguous or the question is about typography (a formula, diagram, table, or theorem box) → call again with images, ideally with `crop` and `image_quality: "cheap"`.

For exact formulas or dense subscripts, `scale: 3` plus `crop` is the exception, not the default.

### Configuration

All keys are optional. Set them in the plugin row's `config` in the profile, using the same names as the comments in `cordis.patch.yml`.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; `false` mounts no tools, routes, or listener. |
| `autoShare` | `true` | Inject the current reading position into `agent/pre-step`; `false` keeps the tools and routes but stops injection. |
| `autoShareSection` | `true` | Resolve the outline section for the injected line. |
| `autoShareMinIntervalMs` | `180000` | Minimum milliseconds between two injections (3 minutes). |
| `autoSharePageDelta` | `1` | Minimum absolute page change before another injection. |
| `autoShareMinSteps` | `1` | Minimum step distance between injections in the same turn. |
| `autoShareMaxAgeMs` | `0` | Ignore reported positions older than this; `0` = no age limit. |
| `allowOutsideWorkspace` | `false` | Let tools read PDFs outside the session working directory. |
| `routeAllowedRoots` | `[]` | Extra directory allowlist for the HTTP routes; `[]` = no extra restriction. |
| `maxPagesPerCall` | `4` | Hard page cap per `pdf_read_pages` call (`1`–`8`), checked before rendering. |
| `defaultScale` | `2.5` | Default render scale (`1`–`3`, about 180 DPI); no token gain above about `2.7`. |
| `maxTextCharsPerPage` | `1200` | Extracted text kept per page; `0` disables text. |
| `maxSearchResults` | `100` | Cap for the tool's and route's search limits (`1`–`500`). |
| `maxOutlineEntries` | `500` | Route outline cap (`1`–`5000`); `pdf_info` additionally caps at 200. |
| `maxLabels` | `0` | Page labels included by `pdf_info`; `0` omits them (cheapest). |
| `outlineDepth` | `1` | `0` = chapters, `1` = sections (default), `2` = subsections. |
| `debugCost` | `false` | Append one JSON cost line per image-returning `pdf_read_pages` call to `.debug-cost.log` beside the package. |
| `debug` | `false` | Include internal error detail in HTTP 500 bodies (development only). |
| `maxFileBytes` | `268435456` | Largest PDF touched by the tools or routes; 256 MiB. |

The code also accepts two advanced keys that are not shown in the sample comments in `cordis.patch.yml`: `maxRouteBodyBytes` (default `65536`, the `POST /current` body cap) and `infoCacheSize` (default `8`, parsed `getInfo` results cached by path + mtime + size).

### Page numbering

Tools and the UI use 1-based pages. `pdf_info` returns `printedOffset`, defined as physical PDF page minus printed page:

```text
physical = printed + printedOffset
```

The test book (`Linear Algebra Done Right`) has `printedOffset = 20`, so printed 132 = PDF 152. The offset is detected from numeric page labels (the mode of the per-page deltas), not hardcoded.

`pdf_info.pageNumberMode` is `"printed"` when numeric labels/offset exist and `"pdf"` otherwise. Tools default to printed numbering in that case; pass `page_numbers: "pdf"` for roman-numeral front matter, PDFs without numeric labels, or whenever you mean physical pages.

The browser readout uses printed numbering when an offset is known and falls back to physical numbering in front matter. In the jump box, a bare `132` means printed 132 when an offset is known; `p152`, `p.152`, `PDF 152`, and `#152` always mean physical PDF 152. Out-of-range input is rejected rather than clamped, so a mistyped printed page cannot silently land on the last page.

### Token economics

DeepSeek vision billing projects an image onto a 14 px patch grid, downsamples 3:1, and caps it at **1024 tokens**:

```text
tokens = gridHeight × (gridWidth + 1) + 2
```

Images smaller than 544×544 are scaled up first. Measured on a 6×9 in book page:

| Render | Pixels | Tokens/page | Notes |
| --- | --- | --- | --- |
| 1.5× (`image_quality: "cheap"`) | 563×954 | **347** | Enough for prose. |
| **2.5× (default)** | 938×1590 | **914** | Highest resolution before downsampling. |
| 3× | 1125×1908 | **1002** | Capped; no gain above about 2.7×. |
| 4× | 1500×2544 | **1002** | Still capped — pure waste. |

- `maxPagesPerCall` (default 4) is enforced before rendering.
- `pdf_read_pages` reports `tokens` per page and `imageTokens` in total; check them.
- Images stay in the conversation and are re-billed on later turns. **Read once, then answer in text.**
- Prefer `crop` and `image_quality: "cheap"` for a quick look; use `scale: 3` with `crop` only for dense subscripts.
- If the context grows too large, DSH's `image-offload` may replace old images with a file name and path; `read_image` can reload them.
- Set `debugCost: true` to append a JSON line per image call to `.debug-cost.log` and measure your own distribution.

### Security

- **Tools are workspace-scoped by default.** The resolved path must stay inside the session working directory, or the call fails with `PDF_OUTSIDE_WORKSPACE`. Set `allowOutsideWorkspace: true` only when reading outside is intentional. Relative tool paths use the session's original `header.cwd`; a later `working_directory` change is not consulted, so prefer absolute paths.
- **HTTP routes are loopback-only but unauthenticated.** They accept only loopback `Host` values (`127.0.0.1`, `localhost`, `::1`), absolute paths, `.pdf` suffixes, regular files, and files within `maxFileBytes`; responses carry no `Access-Control-Allow-Origin` header. Any local process can still use them to read local PDFs — the same tradeoff as `dsh-pdf-search` and other local preview plugins. Set `routeAllowedRoots: ["/path/to/books"]` to restrict the routes (this does **not** restrict model tools).
- **Installing a plugin runs local code with the Host process's privileges.** Install only packages you trust, and review a local checkout before adding it.
- **Renderer hardening:** 60 s document-load timeout, 60 s per-page render timeout, a 50,000,000-pixel canvas cap, at most 2 concurrent renders, at most 4 cached open documents, and the 256 MiB default file cap.
- **`debug: false` by default**, so HTTP 500 bodies do not expose internal detail or paths.

### Known limitations

- **Official PDF preview only.** The controls key off a `.pdf` `absolutePath`; Word/PowerPoint previews (even when internally converted to PDF), images, Markdown, and code previews get no toolbar. The tools can still read `.pdf` files directly.
- **Private DOM markers.** The browser half depends on `data-pdf-page`, `data-textpreview-body`, and `data-document-zoom-scrollport`. A DSH upgrade that renames them can make the controls inert; the preview itself keeps working.
- **Scanned PDFs have no text layer.** `pdf_search` finds nothing and text reads report `textUnavailable`; only page images help. Check `pdf_info.textCoverage.isLikelyScanned` before searching. There is **no OCR**.
- **Search is literal.** The UI uses case-insensitive substring matching: no regex, no whole-word mode, no hyphenation unfolding, and no match-to-match navigation inside a page.
- **The page offset is detected.** PDFs without numeric page labels fall back to physical numbering, and roman front-matter labels cannot be passed to `pdf_read_pages` as printed pages; use `page_numbers: "pdf"` (the browser jump box also accepts `pN`).
- **`pdfjs-dist` must match the Host process.** The package pins `6.3.289`. Other PDF plugins in the same process (for example `dsh-pdf-search`) must use the same version; mixing versions can fail with `API version does not match Worker version`. Upgrade them together.
- **Visual overlap with other preview add-ons.** This search panel is fixed at the top right, as is `dsh-pdf-search`'s find bar; opening both makes them overlap. Their shortcuts are deliberately different (`Cmd/Ctrl+Shift+F` here, `Cmd/Ctrl+F` there).
- **Auto-share state is process-local.** The throttle is not written to the session log, and staying on the same page does not produce a second message; ask `pdf_current_page` when the position is needed later. The reporting toggle is also not persisted across reloads.
- **Page reads require an image-capable model and an attachment store.** Without `ctx.attachments`, `pdf_read_pages` is not registered. Its route check runs before every call — including `include_image: false` — so a text-only model can still use `pdf_info` and `pdf_search` but not page reads.
- **Read-only.** There is no annotation, notes, editing, or OCR. The plugin reads and renders only.

### Development

```
dsh-book-reader/
├─ lib/index.js          host half: four tools, /dsh-pdf-reader routes, auto-share
├─ lib/core/pdf.js       document LRU, page labels/offset, outline, page text, search
├─ lib/core/render.js    pdfjs + @napi-rs/canvas → RGB PNG, with timeouts and a pixel cap
├─ lib/core/tokens.js    DeepSeek vision token accounting
├─ lib/client.js         browser half: header controls, jump, search, share, reporting
├─ lib/host-README.md    host internals: arguments, return shapes, routes
├─ lib/client-README.md  browser internals: UI, shortcuts, DOM markers
├─ SKILL.md              model-facing usage guide
├─ cordis.patch.yml      profile mount + commented defaults
└─ test/*.mjs            headless core / host / client tests
```

`package.json` points `main` at `lib/index.js`, exposes `./client` as `lib/client.js`, sets `dsh.bundle.patch` to `./cordis.patch.yml`, and marks `dsh.client.platform` as `web`. `cordis.patch.yml` inserts plugin id `pdf-reader` under package name `dsh-book-reader`.

There is **no bundler step**: the host half is hand-written ESM, and `lib/client.js` is the browser bundle in the `window.__ModuleLoader__.load` shape, with React as the only external. Runtime dependencies are `pdfjs-dist` pinned to `6.3.289` and `@napi-rs/canvas` `^1.0.11`; `engines.node` is `>=20`. Restart DSH to reload host code, and reload the page for browser-side changes.

#### Host routes

All routes share the historical prefix `/dsh-pdf-reader`, even though the package is now `dsh-book-reader`; the `data-dsh-pdf-reader` DOM markers keep the old name too. Use these exact paths:

- `GET /dsh-pdf-reader/info?path=<absolute .pdf>`
- `GET /dsh-pdf-reader/search?path=<absolute .pdf>&q=<text>&ignoreCase=1&limit=100`
- `POST /dsh-pdf-reader/current` with `{ "path": "...", "pdfPage": 152, "printedPage": 132, "sessionId": "..." }`
- `GET /dsh-pdf-reader/current?sessionId=<id>` (or `?path=<absolute .pdf>` as a fallback)

Responses are JSON with `cache-control: no-store` and `x-content-type-options: nosniff`, and never an `Access-Control-Allow-Origin` header. The browser sends `sessionId`; auto-share only reads positions keyed by the calling session. A `POST /current` without `sessionId` is path-keyed and is not used for auto-share.

#### Tests

```sh
node test/core.test.mjs
node test/host.test.mjs
node test/client.test.mjs
```

Plain Node, no test framework. The core test renders the real LADR PDFs, so those files must be present in the workspace; the client test reuses the `jsdom`/React install under a sibling `dsh-pdf-search/node_modules`. The host test stubs its host services, and jsdom has no layout engine, so the suite does not replace a live GUI smoke test for slot layout, shortcut arbitration, and real PDF.js lazy rendering.

#### Publishing

`npm publish` publishes the npm package (bump `version` first; `publishConfig.access` is already `public`). The `files` whitelist controls what ships; tests, `reference/`, and `node_modules/` are never in the tarball. Push the repository to GitHub separately (`git push`) — the npm package and the GitHub repo are independent artifacts.

After publishing, consumers install by package name as in (a): no manual package symlink and no npm command. The optional skill still needs the symlink in (c). Users must reinstall or update the plugin and restart DSH to pick up a new version; the host half is loaded at startup.

### License

MIT. See [LICENSE](LICENSE).

---

## 中文说明

### 概述

`dsh-book-reader` 在 DSH 右侧栏的官方 PDF 预览上加一组读书控件，同时注册四个模型可调用的工具，让模型**先读文本**。它不替换官方预览器：缩放、适应宽度、选中文字、刷新、自动刷新都保持原样；删掉插件行，预览恢复原状。

控件只挂在 `absolutePath` 以 `.pdf` 结尾的预览上。PDF 在宿主进程内用 `pdfjs-dist` + `@napi-rs/canvas` 解析和渲染；浏览器端把控件加进预览的 document-header 插槽。

```
┌─ 官方 PDF 预览（PDF.js）──────────────────────────────────┐
│  刷新  缩放 …  │  ‹   ›   [132] / 410   ⌕   ↗   AI●     │  ← 本插件注入
├──────────────────────────────────────────────────────────┤
│                     页面内容 …                            │
└──────────────────────────────────────────────────────────┘
```

设计原则：**默认只花文本的 token；图片是需要时才付的钱，不是第一步。**

### 功能

| 控件 | 行为 |
| --- | --- |
| `‹` / `›` | 上一页 / 下一页（按**物理** PDF 页连续翻，与印刷页码无关）。 |
| `[132] / 410` | 当前页读数，随滚动更新；也是跳页框（输入页码后按 `Enter`）。已知偏移时显示印刷页码，否则显示物理页码。 |
| `⌕` | 打开全文搜索面板。结果显示为 `p.132 — 摘要`，点击跳转；每行还有 **`→ AI`**，把 `PDF p.132: <摘要>` 插到对话输入框光标处。 |
| `↗` | 把 `[PDF p.132]` 插到输入框光标处，是一次可撤销的编辑，不覆盖草稿。 |
| `AI` + 状态点 | 阅读位置上报开关（默认开启）。状态点：绿色 = 宿主已确认，琥珀 = 发送中，红色 = 宿主路由失败，变暗 = 关闭。所有已挂载的 PDF 预览共用这个开关，刷新后不保留。 |
| `Cmd/Ctrl + Shift + F` | 对指针最后停留/聚焦的预览打开搜索面板，并聚焦、全选查询词。`Cmd/Ctrl + F` 故意不拦截。 |

`Esc` 关闭面板；页码框里 `Enter` 跳页；搜索框里 `Enter` 跳到第一条结果。鼠标悬停或键盘聚焦时，每个控件都会显示提示，语言跟随 DSH 当前界面语言（中文或英文）。

读数第一次解析成功后，浏览器会在滚动停止 400 ms 后上报页码变化。开启自动上报时，宿主在满足节流条件时每一步最多注入一条很短的来源标记（按默认间隔，最多每 3 分钟一条）：

```text
[dsh-pdf-reader] 正在阅读《book》printed 132 (PDF 152) · Chapter 5 › 5B
```

它**只是位置标记**，不会命令模型读页。读不读、读哪页、要不要图，由模型自己判断；需要时也可以用 `pdf_current_page` 再取一次。注入受页变化、最小间隔（默认 3 分钟）和步距约束。

### 安装

#### a) 发布包

在 DSH 的 **Plugins** 页里点 **Add plugin**，输入 `dsh-book-reader`（或锁定版本 `dsh-book-reader@0.1.0`）。等价的命令行：

```sh
dsh plugin --profile <name> add dsh-book-reader
```

装完后完全重启 DSH；宿主端随进程启动加载。用发布包安装时，消费者**不需要手动给包建软链，也不需要 npm 命令**；如果还需要 skill，唯一的手动步骤是下面的可选注册。

#### b) 本地开发目录

```sh
dsh plugin add "/abs/path/to/dsh-book-reader"
# 需要指定非默认 profile 时，在 plugin 后加 --profile <name>
```

然后重启 DSH。profile 记录的是指向源码目录的 `link:`，所以源码目录**和它的 `node_modules/`** 都必须留在原处：宿主运行时要从那里 `import 'pdfjs-dist'` 和 `@napi-rs/canvas`。当前目录里的 `node_modules/` 是 macOS arm64 的；其他架构请先在目录里执行 `npm install`。`engines.node` 要求 Node >= 20。

卸载：`dsh plugin --profile <name> remove dsh-book-reader`，再重启 DSH。首次启用建议走 GUI 开关，而不是手改 `dsh.profile.bundles`；如果安装后 profile 启动失败，可先用命令行移除插件行再重启。

#### c) 注册 skill

```sh
mkdir -p "<workspace>/.dsh/skills"
ln -sfn "/abs/path/to/dsh-book-reader" "<workspace>/.dsh/skills/pdf-reader"
```

包里带了 `SKILL.md`，但 DSH 的打包**不会自动注册 skill**。软链名必须是 `pdf-reader`（即 `SKILL.md` 里的 `name`）；如果是 npm 安装的包，就指向已安装的包目录。不注册 skill 也能用这些工具，但注册后模型才知道文本优先的流程、成本表和常见陷阱。每个工作区注册一次即可。

发布之后，消费者用包名安装插件不需要手动软链，也不需要 npm 命令；只有这个可选的 skill 注册仍需手动。

### 工具

四个工具，三档成本。默认走文本。

| 工具 | 成本 | 用途 |
| --- | --- | --- |
| `pdf_info` | ~0（纯文本） | 页数、印刷页↔物理页偏移、目录/TOC；也返回标题、作者、文件大小、页面尺寸和 `textCoverage.isLikelyScanned`。 |
| `pdf_search` | ~0（纯文本） | 定位短语、定理编号、图表标题。 |
| `pdf_read_pages` + `include_image: false` | ~0（纯文本，按页） | 正文、定理陈述、习题文字。 |
| `pdf_read_pages`（带图） | **~350–1024 token/页** | 公式、图表、表格、版式。 |
| `pdf_current_page` | ~0 | 用户当前在看哪一页、哪一节。 |

`pdf_read_pages` 是唯一返回图片的工具。它只在宿主挂载了 `ctx.attachments` 时注册（PNG 才能成为持久的图片附件）；如果当前路由的模型不接受图片输入，任何调用都会失败，`include_image: false` 也不例外。

页码是 **1-based**，相对路径按会话工作目录解析。`pages` 支持 `"132-134"`、`"132,135"`、`132`、`[132,133,134]`，也支持范围字符串组成的数组。其他常用参数：

- `page_numbers`：`"printed"` 或 `"pdf"`；PDF 有数字页标签/偏移时默认 `"printed"`。
- `scale`：`1`–`3`，默认 `2.5`（约 180 DPI）。
- `crop`：以左上角为原点的分数——`"x0,y0,x1,y1"`、`[x0,y0,x1,y1]` 或 `{x,y,w,h}`。
- `image_quality`：`"cheap"`（1.5×，约 350 token/页）或 `"standard"`（用 `defaultScale`）。
- `include_image`：默认 `true`；`false` 只返回页文本，不产生图片 token。
- `include_text`：默认 `true`，受 `maxTextCharsPerPage` 限制。

单次调用在**渲染之前**就按 `maxPagesPerCall`（默认 **4**，硬上限 **8**）校验；超了直接报错，不会悄悄丢页。`pdf_read_pages` 返回每页的 `tokens` 和合计 `imageTokens`，以及每页的 `text`、`textTruncated`、`textUnavailable`。`pdf_info` 的目录最多 200 条；`pdf_search` 默认 20 条（受 `maxSearchResults` 限制）。

#### 文本优先流程

1. 每份文档先调一次 `pdf_info`，记下 `printedOffset`、`pageNumberMode` 和目录。不要把偏移量写死。
2. 用 `pdf_search` 搜一个有辨识度的短语，拿到物理页码。
3. 用 `pdf_read_pages` 配 **`include_image: false`**，把这几页当文本读。
4. 只有文本有歧义，或问题本身与排版有关（公式、图、表、定理框）时，才带图再调一次，优先用 `crop` 和 `image_quality: "cheap"`。

精确公式或密集下标是例外：用 `scale: 3` 配 `crop`，但不要当成默认。

### 配置

全部可选。通过 profile 中插件行的 `config` 设置，键名与 `cordis.patch.yml` 注释一致。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；`false` 时不挂载任何工具、路由或监听器。 |
| `autoShare` | `true` | 把当前阅读位置注入 `agent/pre-step`；`false` 保留工具和路由，只停注入。 |
| `autoShareSection` | `true` | 为注入行解析目录中的小节。 |
| `autoShareMinIntervalMs` | `180000` | 两次注入的最小间隔（3 分钟）。 |
| `autoSharePageDelta` | `1` | 再次注入前要求的最小绝对页变化。 |
| `autoShareMinSteps` | `1` | 同一轮内两次注入的最小步距。 |
| `autoShareMaxAgeMs` | `0` | 忽略早于此时长的位置；`0` = 不限。 |
| `allowOutsideWorkspace` | `false` | 允许工具读取会话工作区外的 PDF。 |
| `routeAllowedRoots` | `[]` | HTTP 路由的额外目录白名单；`[]` = 不额外限制。 |
| `maxPagesPerCall` | `4` | 单次 `pdf_read_pages` 的硬页数上限（`1`–`8`），渲染前校验。 |
| `defaultScale` | `2.5` | 默认渲染倍率（`1`–`3`，约 180 DPI）；超过约 `2.7` 没有 token 收益。 |
| `maxTextCharsPerPage` | `1200` | 每页保留的抽取文本字符数；`0` 关闭文本。 |
| `maxSearchResults` | `100` | 工具和路由搜索条数的上限（`1`–`500`）。 |
| `maxOutlineEntries` | `500` | 路由目录条数上限（`1`–`5000`）；`pdf_info` 另有 200 条上限。 |
| `maxLabels` | `0` | `pdf_info` 返回的页标签数量；`0` = 不返回（最省）。 |
| `outlineDepth` | `1` | `0` = 章，`1` = 节（默认），`2` = 小节。 |
| `debugCost` | `false` | 每次带图的 `pdf_read_pages` 往包目录下的 `.debug-cost.log` 追加一行 JSON 成本记录。 |
| `debug` | `false` | 在 HTTP 500 响应里带内部错误细节（仅开发用）。 |
| `maxFileBytes` | `268435456` | 工具或路由能碰的最大 PDF；256 MiB。 |

代码还接受两个键，只是 `cordis.patch.yml` 的示例注释里没有列出：`maxRouteBodyBytes`（默认 `65536`，`POST /current` 的请求体上限）和 `infoCacheSize`（默认 `8`，按路径 + mtime + size 缓存的 `getInfo` 结果数）。

### 页码

工具和界面都用 1-based 页码。`pdf_info` 返回 `printedOffset`，定义是「物理 PDF 页 − 印刷页」：

```text
物理页 = 印刷页 + printedOffset
```

测试用的《Linear Algebra Done Right》`printedOffset = 20`，所以 printed 132 = PDF 152。偏移量是从数字页标签的逐页差值中探测出来的，不要写死。

`pdf_info.pageNumberMode` 在有数字标签/偏移时为 `"printed"`，否则为 `"pdf"`。可探测时工具默认用印刷页码；前言页、罗马数字标签、没有数字标签的 PDF，或者你就是想说物理页时，传 `page_numbers: "pdf"`。

浏览器读数在已知偏移时显示印刷页码，前言部分退回物理页码。跳页框里，裸数字 `132` 在已知偏移时按 printed 132 处理；`p152`、`p.152`、`PDF 152`、`#152` 强制物理页 152。超出 `1..pageCount` 的输入会被拒绝，不会截断到最后一页，所以打错的印刷页不会悄悄跳到全书末尾。

### Token 成本

DeepSeek 的视觉计费：图片先对齐到 14 px patch 网格，按 3:1 降采样，单图上限 **1024 token**：

```text
tokens = 网格高 × (网格宽 + 1) + 2
```

小于 544×544 的图会先放大。6×9 英寸书页实测：

| 渲染 | 像素 | token/页 | 说明 |
| --- | --- | --- | --- |
| 1.5×（`image_quality: "cheap"`） | 563×954 | **347** | 只读正文够用。 |
| **2.5×（默认）** | 938×1590 | **914** | 未被降采样的最高分辨率。 |
| 3× | 1125×1908 | **1002** | 已触顶；超过约 2.7× 没有收益。 |
| 4× | 1500×2544 | **1002** | 仍然触顶，纯属浪费。 |

- `maxPagesPerCall`（默认 4）在渲染前校验。
- `pdf_read_pages` 返回每页 `tokens` 和合计 `imageTokens`，记得看。
- 图片会留在对话里，后续轮次仍会计费。**读一次，然后用文本回答。**
- 快速看一眼用 `crop` + `image_quality: "cheap"`；只有密集下标才需要 `scale: 3` 配 `crop`。
- 上下文太大时，DSH 的 `image-offload` 可能把旧图替换成文件名+路径；仍可用 `read_image` 重读。
- 设 `debugCost: true` 后，每次带图调用会往 `.debug-cost.log` 追加一行 JSON，便于统计自己的真实成本分布。

### 安全

- **工具默认只在工作区内。** 解析后的路径必须落在当前会话工作目录内，否则返回 `PDF_OUTSIDE_WORKSPACE`。确实要读工作区外的 PDF 时，才显式设 `allowOutsideWorkspace: true`。相对路径按会话最初的 `header.cwd` 解析，之后改 `working_directory` 不会影响它，所以建议用绝对路径。
- **HTTP 路由只认回环 Host，但没有鉴权。** 只接受 `127.0.0.1`、`localhost`、`::1` 这类回环 `Host`，路径必须是绝对路径、`.pdf` 后缀、普通文件，且不超过 `maxFileBytes`；响应不带 `Access-Control-Allow-Origin`。本机任何进程仍可借它读取本机 PDF，这与 `dsh-pdf-search` 等本地预览插件是同一权衡。要收紧就设 `routeAllowedRoots: ["/path/to/books"]`；它只管 HTTP 路由，**不管**模型工具。
- **安装插件等于在宿主进程里运行本地代码。** 只装你信任的包；从本地目录安装前先看代码。
- **渲染保护：** 文档加载 60 s 超时，单页渲染 60 s 超时，画布上限 5000 万像素，同时最多 2 个渲染任务，最多缓存 4 个已打开文档，默认文件上限 256 MiB。
- **默认 `debug: false`**，HTTP 500 不返回内部错误细节和路径。

### 已知限制

- **只支持官方 PDF 预览。** 控件按 `.pdf` 的 `absolutePath` 匹配；Word/PowerPoint（即使预览时内部转成了 PDF）、图片、Markdown、代码预览都不会出现工具栏。工具仍可直接读 `.pdf` 文件。
- **依赖官方预览的私有 DOM 标记。** 浏览器端依赖 `data-pdf-page`、`data-textpreview-body`、`data-document-zoom-scrollport`；DSH 升级若改名，控件会失效，但预览本身不受影响。
- **扫描件没有文本层。** `pdf_search` 搜不到，文本读页返回 `textUnavailable`，只能看图；**没有 OCR**。搜之前先看 `pdf_info.textCoverage.isLikelyScanned`。
- **搜索是字面匹配。** 界面用大小写不敏感的子串匹配：没有正则、整词模式，不会展开连字符断行，也不能在一页内逐个跳匹配。
- **页码偏移是探测的。** 没有数字页标签的 PDF 退化为物理页模式；前言页的罗马数字标签不能直接传给 `pdf_read_pages`，请用 `page_numbers: "pdf"`（浏览器跳页框还可以用 `pN`）。
- **`pdfjs-dist` 版本必须和宿主进程一致。** 本包锁定 `6.3.289`；同一进程里的其他 PDF 插件（例如 `dsh-pdf-search`）必须用同一版本，混用会报 `API version does not match Worker version`。升级时一起升。
- **可能和其他预览插件视觉重叠。** 搜索面板固定在右上角，和 `dsh-pdf-search` 的查找条同时打开会重叠；快捷键故意错开（这里是 `Cmd/Ctrl+Shift+F`，那边是 `Cmd/Ctrl+F`）。
- **自动上报状态在进程内存里。** 节流状态不写入会话日志；用户停在同一页时不会重复注入，需要位置时模型应调用 `pdf_current_page`。上报开关也不跨刷新保留。
- **读页需要附件服务和支持图片的模型。** 没有 `ctx.attachments` 时 `pdf_read_pages` 不注册。每次调用都会先做路由检查，`include_image: false` 也不例外；所以纯文本模型仍可用 `pdf_info` 和 `pdf_search`，但不能读页。
- **只读。** 没有批注、笔记、编辑、OCR；插件只负责读取和渲染。

### 开发

```
dsh-book-reader/
├─ lib/index.js          宿主端：4 个工具、/dsh-pdf-reader 路由、自动位置注入
├─ lib/core/pdf.js       文档 LRU、页标签/偏移、目录、页文本、搜索
├─ lib/core/render.js    pdfjs + @napi-rs/canvas → RGB PNG，带超时与像素上限
├─ lib/core/tokens.js    DeepSeek 视觉 token 计算
├─ lib/client.js         浏览器端：header 控件、跳页、搜索、分享、上报
├─ lib/host-README.md    宿主内部文档：参数、返回结构、路由
├─ lib/client-README.md  浏览器内部文档：界面、快捷键、DOM 标记
├─ SKILL.md              模型使用手册
├─ cordis.patch.yml      profile 挂载 + 注释掉的默认值
└─ test/*.mjs            core / host / client 无头测试
```

`package.json` 的 `main` 是 `lib/index.js`，`exports["./client"]` 指向 `lib/client.js`，`dsh.bundle.patch` 指向 `./cordis.patch.yml`，`dsh.client.platform` 是 `web`。`cordis.patch.yml` 以插件 id `pdf-reader`、包名 `dsh-book-reader` 插入。

**没有打包步骤**：宿主端是手写 ESM，浏览器端 `lib/client.js` 直接是 `window.__ModuleLoader__.load` 形式的 bundle，React 是唯一外部依赖。运行时依赖：`pdfjs-dist` 锁定 `6.3.289`，`@napi-rs/canvas` `^1.0.11`；`engines.node >= 20`。改宿主代码后重启 DSH 才生效；改浏览器端后刷新页面。

#### 宿主路由

所有路由共用一个历史前缀 `/dsh-pdf-reader`：包名已经是 `dsh-book-reader`，但线上路径和 `data-dsh-pdf-reader` DOM 标记仍保留旧名。调用时用下面的精确路径：

- `GET /dsh-pdf-reader/info?path=<absolute .pdf>`
- `GET /dsh-pdf-reader/search?path=<absolute .pdf>&q=<text>&ignoreCase=1&limit=100`
- `POST /dsh-pdf-reader/current`，请求体 `{ "path": "...", "pdfPage": 152, "printedPage": 132, "sessionId": "..." }`
- `GET /dsh-pdf-reader/current?sessionId=<id>`（没有会话 id 时可用 `?path=<absolute .pdf>` 兜底）

响应都是 JSON，带 `cache-control: no-store` 和 `x-content-type-options: nosniff`，不带 `Access-Control-Allow-Origin`。浏览器端会传 `sessionId`；自动上报只读调用会话的位置。`POST /current` 不带 `sessionId` 时只按路径记位置，不会被自动上报使用。

#### 测试

```sh
node test/core.test.mjs
node test/host.test.mjs
node test/client.test.mjs
```

纯 Node，不用测试框架。core 测试会渲染真实的 LADR PDF，所以工作区里要有那两个文件；client 测试复用同级 `dsh-pdf-search/node_modules` 里的 `jsdom`/React。host 测试会替换宿主服务，jsdom 也没有布局引擎，因此整套测试不能代替真实 GUI 里对插槽布局、快捷键冲突和 PDF.js 懒渲染的冒烟验证。

#### 发布

先升 `version`，再执行 `npm publish` 发布 npm 包（`publishConfig.access` 已经是 `public`）。`files` 白名单决定哪些文件进包；测试、`reference/`、`node_modules/` 都不会进 tarball。仓库另外推到 GitHub（`git push`）；npm 包和 GitHub 仓库是两个独立产物。

发布后，消费者按 (a) 用包名安装即可，不需要手动给包建软链，也不需要 npm 命令；只有可选的 skill 仍需按 (c) 建软链。用户升级时要重新安装/更新插件并重启 DSH，宿主端在启动时加载，不能原地热升级。

### 许可证

许可证：MIT。
