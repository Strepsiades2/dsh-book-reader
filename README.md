# dsh-pdf-reader

在 DSH 右侧栏的官方 PDF 预览上，加一套**读书**控件，并把"你正在读哪一页"变成 AI 可用的上下文。

它**不替换**官方预览器：缩放、适应宽度、文字选择、刷新、Office→PDF 全部保持原样。删掉插件行，一切恢复。

```
┌─ 官方 PDF 预览（PDF.js）──────────────────────────────┐
│  ‹  ›   [ 132 ] / 410      ⌕      ↗ AI●              │  ← 本插件注入的 header
├──────────────────────────────────────────────────────┤
│                                                      │
│                    页面内容 …                         │
└──────────────────────────────────────────────────────┘
```

## 能力一览

**给人用的**

| 控件 | 行为 |
| --- | --- |
| `‹` / `›` | 上一页 / 下一页（物理页连续） |
| `[132] / 410` | 当前页读数，随滚动更新；同时是可输入的跳页框（输入 `132` + Enter） |
| `⌕` | 搜索面板：结果列表 `p.132 — 摘要`，点击跳转；每行有 **`→ AI`** 按钮把该页摘要插入输入框 |
| `↗` | 把当前页 `[PDF p.132]` 插入对话输入框光标处（**不覆盖已打的草稿**） |
| `AI` + 状态点 | 自动上下文开关：绿=宿主已确认，琥珀=发送中，红=路由失败，暗=关闭 |

**给 AI 用的（4 个模型工具）**

| 工具 | 作用 | 成本 |
| --- | --- | --- |
| `pdf_info` | 页数、**书签目录（TOC）**、印刷页↔物理页偏移、页标签 | 极低（纯文本） |
| `pdf_search` | 全文搜索 → `{pdf, printed, snippet}` | 极低（~0.8 s / 410 页） |
| `pdf_read_pages` | 渲染指定页 → **图片直接进上下文**（经 attachment 服务） | ~347–1024 token/页 |
| `pdf_current_page` | 用户当前在看哪一页、属于哪一节 | 极低 |

此外插件会在 `agent/pre-step` 注入一条**很短的**上下文消息，让模型知道"用户正在读第 132 页（5A 节）"。默认按"换页触发 + 最短 3 分钟 + 每步最多一条"节流，可在配置里关掉。

## 安装

```sh
dsh plugin --profile desktop add "/absolute/path/to/dsh-pdf-reader"
```

然后**重启 DSH**（宿主插件需要重新加载 profile）。在 GUI 的 设置 → 插件 里也能开关。

> ⚠️ **源码目录和它的 `node_modules/` 必须留在原处。** profile 记录的是 `link:` 软链，插件在运行时需要从源码目录 `import 'pdfjs-dist'`。
>
> `node_modules/` 是 **macOS arm64** 的；其他架构请在该目录执行 `npm install`。

卸载：

```sh
dsh plugin --profile desktop remove dsh-pdf-reader
```

## 上下文经济学（为什么默认 2.5×）

DSH 内置了 DeepSeek 官方的视觉 token 计费实现（`@deepseek-ai/dsh-llm-deepseek` 的 `image-tokens` 模块）。规则是：图片按 **14 px patch 对齐、3:1 降采样**投影到 token 网格，`tokens = 网格高 × (网格宽 + 1) + 2`，**单图硬上限 1024 token**，小于 `544×544` 的图会先被放大。

对 6×9 in 版式的书页（750:1272）实测：

| 渲染 | 像素 | token | 说明 |
| --- | --- | --- | --- |
| 1.5× | 563×954 | **347** | `image_quality: "cheap"`，只读文字够用 |
| 2× | 750×1272 | 591 | |
| **2.5×** | 938×1590 | **914** | **默认**：尚未触顶的最高可用分辨率 |
| 2.7× | 1013×1717 | 1002 | 接近上限 |
| 3× | 1125×1908 | **1002** | 已被压到上限 |
| 4× | 1500×2544 | **1002** | 同上，纯浪费带宽 |

结论：

- **渲染超过 ~2.7× 没有意义**——provider 会压回同一个 24×40 网格，token 一分不省。
- 10 页 2.5× ≈ **9.1k token**；20 页会同时撞到"单消息 20 张图"的硬限制。
- 所以工具设计成 **`maxPagesPerCall: 4`**，并推荐"先用 `pdf_search` 定位（几百 token），再只渲染需要的 1–4 页"。
- 超预算时 DSH 的 `image-offload` 会把旧图替换成"文件名 + 路径"的文字，仍可用 `read_image` 重新读，不会撑爆会话。

想再省：给 `pdf_read_pages` 传 `crop`（页边距裁掉）或 `image_quality: "cheap"`。

## 架构

```
dsh-pdf-reader/
├─ lib/index.js       宿主：4 个工具 + HTTP 路由 + agent/pre-step 上下文注入
├─ lib/client.js      浏览器：header 控件、跳页、搜索面板、→AI、自动上报
├─ lib/core/
│   ├─ pdf.js         LRU 文档缓存、页标签/偏移探测、目录解析、全文搜索
│   └─ render.js      pdfjs-dist + @napi-rs/canvas → 8-bit RGB PNG（进程内）
├─ cordis.patch.yml   挂在 profile 上的 bundle patch（含全部可配项）
├─ test/              core / host / client 三组纯 node 测试
└─ reference/         从 app.asar 抽出的 DSH 官方文档（官方预览器/侧边栏 API）
```

**渲染是进程内的**：`pdfjs-dist` 负责解析，`@napi-rs/canvas` 负责光栅化，不依赖 Swift/PDFKit、不 shell out、不需要外部脚本。

### 宿主路由（浏览器用）

| 路由 | 作用 |
| --- | --- |
| `GET /dsh-pdf-reader/info?path=` | 页数、偏移、目录 |
| `GET /dsh-pdf-reader/search?path=&q=&ignoreCase=&limit=` | 搜索结果 |
| `POST /dsh-pdf-reader/current` | 上报当前阅读位置（按 session） |
| `GET /dsh-pdf-reader/current?sessionId=` | 读取当前阅读位置 |

所有路由都按 `dsh-pdf-search` 的做法加固：只认 loopback Host、绝对路径、`.pdf` 后缀、普通文件、体积上限。

## 键盘

| 按键 | 动作 |
| --- | --- |
| `Cmd/Ctrl + Shift + F` | 打开搜索面板 |
| `Cmd/Ctrl + F` | **不拦截**——留给 `dsh-pdf-search` 和浏览器 |
| `Esc` | 关闭面板 / 取消输入 |
| 跳页框 `Enter` | 纯数字 = 印刷页码；`p152` / `#152` = 物理页 |

## 测试

```sh
node test/core.test.mjs    # 19 项：页数、偏移、目录、搜索、渲染、错误路径
node test/host.test.mjs    # 36 项：工具 schema、页区间解析、路由校验、节流、图片块
node test/client.test.mjs  #      浏览器 bundle、槽位注册、页码、插入、防抖、清理
```

实测性能（macOS arm64 / Node 24）：冷启 `getInfo` ~94 ms，热 ~0.05 ms；410 页全文搜索 ~0.8 s；渲染单页 ~26 ms，三页 ~66 ms；打开一本书常驻约 130 MB。

## 依赖约束（重要）

`pdfjs-dist` 必须与**同一宿主进程里其他插件用的版本一致**。本机还装着 `dsh-pdf-search`，它依赖 `pdfjs-dist@6.3.289`；两个版本共存时，PDF.js 会报：

```
The API version "6.4.299" does not match the Worker version "6.3.289"
```

所以 `package.json` 里把 `pdfjs-dist` **精确 pin 在 `6.3.289`**（不是 `^`）。升级本插件前先确认进程内没有别的版本，或同步升级所有相关插件。

> 改完依赖必须**重启 DSH**：宿主进程的 ESM 模块是加载即缓存，换文件不会热替换。

## 排查

插件装上但 header 没出现 / 工具报错时：

```sh
# 1. profile 里是否登记、链接是否有效
grep dsh-pdf-reader ~/.dsh/profiles/desktop/package.json
ls -la ~/.dsh/profiles/desktop/node_modules/dsh-pdf-reader

# 2. 三组离线测试是否还绿（不依赖运行中的 DSH）
cd "<this repo>" && node test/core.test.mjs && node test/host.test.mjs && node test/client.test.mjs

# 3. 宿主进程里的版本一致性（最常见的坑）
node -e "console.log(require('./node_modules/pdfjs-dist/package.json').version)"
node -e "console.log(require('../dsh-pdf-search/node_modules/pdfjs-dist/package.json').version)"
```

- **改了任何依赖或 `lib/index.js` 之后必须完全退出并重开 DSH**——宿主进程 ESM 模块加载即缓存，浏览器刷新不会重新加载宿主。
- 报 `API version "x" does not match the Worker version "y"`：进程内有两个 `pdfjs-dist`，把本插件的版本对齐到另一份（见上节）。
- header 控件不出现：多半是槽位匹配失败（`absolutePath` 不是 `.pdf`）或宿主插件整行没挂载；对照 `lib/client-README.md` 的 DOM/槽位假设。

## 已知限制

- 只挂在**官方 PDF 预览**（含 Office→PDF 转出来的那个）；图片、Excel、Markdown 预览不受影响。
- 依赖官方预览器的私有 DOM 标记（`data-pdf-page`、`data-document-zoom-scrollport` 等），**DSH 升级可能失效**；`dsh-pdf-search` 依赖同一批标记。
- 扫描件（无文本层）搜索不到，只能看图。
- 搜索是字面匹配，不处理连字符断词（`decom-\nposition` 匹配不到 `decomposition`）。
- 前端 `→ AI` / `↗` 插入的是**文本引用**，真正的页面图片由模型调用 `pdf_read_pages` 获取——这样同一页不会被重复塞进上下文。
- `printedOffset` 是**探测**出来的，不是写死 20；换一本没有数字页标签的书会退化为物理页模式。

## License

MIT。`reference/` 下的文档版权归 DeepSeek（从本机 app.asar 抽出，仅供开发参考）。
