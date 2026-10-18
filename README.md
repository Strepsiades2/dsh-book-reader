# dsh-book-reader

在 DSH 右侧栏的官方 PDF 预览上，加一套**读书**控件；并给模型一套**文本优先、按需看图**的 PDF 上下文工具。

它**不替换**官方预览器：缩放、适应宽度、文字选择、刷新、Office→PDF 全部保持原样。删掉插件行，一切恢复。

```
┌─ 官方 PDF 预览（PDF.js）──────────────────────────────────┐
│  刷新 缩放 …  │  ‹  ›  [ 132 ] / 410   ⌕   ↗   AI●      │ ← 本插件注入
├──────────────────────────────────────────────────────────┤
│                     页面内容 …                            │
└──────────────────────────────────────────────────────────┘
```

> 设计原则：**默认只花文本的 token。** 图片是"需要时才付的钱"，不是第一步。

## 能做什么

**给人用的**

| 控件 | 行为 |
| --- | --- |
| `‹` / `›` | 上一页 / 下一页 |
| `[132] / 410` | 当前页读数，随滚动更新；也是跳页框（输入 `132` + Enter） |
| `⌕` | 搜索面板：`p.132 — 摘要`，点击跳转；每行 `→ AI` 把该页引用插到输入框 |
| `↗` | 把 `[PDF p.132]` 插入对话输入框光标处（不覆盖草稿） |
| `AI` + 状态点 | 自动位置上报开关（绿=已确认 / 琥珀=发送中 / 红=失败 / 暗=关） |
| `Cmd/Ctrl + Shift + F` | 打开搜索面板（`Cmd/Ctrl + F` 不拦截，留给浏览器） |

**给 AI 用的（4 个工具，3 个价位）**

| 工具 | 成本 | 用途 |
| --- | --- | --- |
| `pdf_info` | 极低（纯文本） | 页数、印刷页↔物理页偏移、目录 |
| `pdf_search` | 极低（纯文本） | 全文定位 |
| `pdf_read_pages` + `include_image:false` | 极低（纯文本） | 读正文、定理陈述 |
| `pdf_read_pages`（带图） | **~350–1024 token/页** | 公式、图表、版式 |
| `pdf_current_page` | 极低 | 用户当前在看哪页、属于哪节 |

**自动注入**：每轮最多一条极短的位置标记，**只给页码，不命令模型读**：

```
[dsh-pdf-reader] 正在阅读《book》printed 132 (PDF 152) · Chapter 5 › 5B
```

是否读、读哪页、要不要图，由模型自己判断（详见 `SKILL.md`）。

## 安装

```sh
# 1) 插件
dsh plugin --profile desktop add "/absolute/path/to/dsh-book-reader"
#    然后完全重启 DSH（宿主插件需要重新加载 profile）

# 2) 技能（把工具用法交给模型）
mkdir -p "<workspace>/.dsh/skills"
ln -sfn "/absolute/path/to/dsh-book-reader" "<workspace>/.dsh/skills/pdf-reader"
```

> ⚠️ 源码目录和 `node_modules/` 必须留在原处：profile 记录的是 `link:` 软链，宿主运行时要从源码目录 `import 'pdfjs-dist'`。
>
> `node_modules/` 是 **macOS arm64** 的；其他架构请在该目录执行 `npm install`。

卸载：`dsh plugin --profile desktop remove dsh-book-reader`。

## 上下文经济学

DeepSeek 视觉计费：图片按 **14 px patch** 对齐、**3:1 降采样**投影到 token 网格，`tokens = 网格高 × (网格宽+1) + 2`，**单图上限 1024**，小于 `544×544` 会先放大。6×9 in 书页实测：

| 渲染 | 像素 | token | 说明 |
| --- | --- | --- | --- |
| 1.5×（`image_quality:"cheap"`） | 563×954 | **347** | 只读文字够用 |
| **2.5×（默认）** | 938×1590 | **914** | 未被降采样的最高分辨率 |
| 3× | 1125×1908 | 1002 | 已触顶 |
| 4× | 1500×2544 | 1002 | 同上，纯浪费 |

结论：**超过 ~2.7× 渲染没有收益**。所以：

- `maxPagesPerCall` 默认 **4**，且在渲染**之前**就校验；
- 工具返回每页 `tokens` 和合计 `imageTokens`；
- 推荐流程：`pdf_info` → `pdf_search` → 文本读页 → 只在公式/图表处开图；
- 超预算时 DSH 的 `image-offload` 会把旧图替换成"文件名+路径"，仍可用 `read_image` 重读。

想积累真实成本分布：`debugCost: true` → 每次 `pdf_read_pages` 追加一行 JSON 到 `.debug-cost.log`。

## 配置

全部可选，默认见 `cordis.patch.yml` 注释。常用：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `autoShare` | `true` | 关掉位置注入 |
| `autoShareMinIntervalMs` | `180000` | 两次注入最小间隔 |
| `maxPagesPerCall` | `4` | 单次读页上限 |
| `defaultScale` | `2.5` | 默认渲染倍率 |
| `outlineDepth` | `1` | `pdf_info` 目录深度（0 章 / 1 节 / 2 小节） |
| `maxLabels` | `0` | `pdf_info` 是否返回页标签（0 = 不返回，最省） |
| `debug` | `false` | HTTP 500 里是否带错误细节 |
| `debugCost` | `false` | 是否记录成本日志 |

## 架构

```
dsh-book-reader/
├─ lib/index.js       宿主：4 工具 + 4 路由 + 位置注入
├─ lib/client.js      浏览器：header 控件、跳页、搜索、→AI、上报
├─ lib/core/pdf.js    LRU 文档缓存、页标签/偏移探测、目录、全文搜索
├─ lib/core/render.js pdfjs + @napi-rs/canvas → RGB PNG（进程内，带超时与像素上限）
├─ lib/core/tokens.js DeepSeek 视觉 token 计算（逐行对照官方实现）
├─ SKILL.md           模型使用手册（工具细节、成本、陷阱）
├─ cordis.patch.yml   profile 挂载 + 全部配置项
└─ test/              core / host / client 三组纯 node 测试
```

渲染是**进程内**的：`pdfjs-dist` 解析 + `@napi-rs/canvas` 光栅化，不依赖外部脚本（约 26 ms/页）。

### 宿主路由（浏览器用，JSON，无 CORS 头）

`GET /dsh-book-reader/info?path=` · `GET /dsh-book-reader/search?path=&q=…` · `POST /dsh-book-reader/current` · `GET /dsh-book-reader/current?sessionId=`

路由按 `dsh-pdf-search` 的做法加固：只认 loopback Host、绝对路径、`.pdf` 后缀、普通文件、体积上限。

## 测试

```sh
node test/core.test.mjs    # 19 项
node test/host.test.mjs    # 39 项
node test/client.test.mjs  # 浏览器 bundle
```

## 已知限制

- 只挂在**官方 PDF 预览**（含 Office→PDF）；图片/Excel/Markdown 预览不受影响。
- 依赖官方预览器的私有 DOM 标记（`data-pdf-page`、`data-document-zoom-scrollport`），**DSH 升级可能失效**。
- 扫描件无文本层：搜索为空，只能看图。
- 搜索是字面匹配，不处理连词断行。
- `printedOffset` 是**探测**的；无数字页标签的 PDF 退化为物理页模式。
- 路由只做 loopback 校验、**无鉴权**：本机任何进程都能借它读本机任意 PDF（与 `dsh-pdf-search` 同一权衡）。
- 与 `dsh-pdf-search` 的查找条可能视觉重叠（两者都固定在右上角）。

## 发布前检查（npm）

1. **包名**：`dsh-pdf-reader` 在 npm 已被占用（0.2.0），本包改名为 **`dsh-book-reader`**（已确认可用）。
2. **`private`** 已移除，`publishConfig.access = public`，`license = MIT` + `LICENSE` 文件。
3. `files` 白名单已包含 `lib/**`、`SKILL.md`、`cordis.patch.yml`、`README.md`、`LICENSE`。
4. **`node_modules` 不会随包发布**；消费者需要 `npm install`（`pdfjs-dist` 精确 pin 6.3.289，见下）。
5. `pdfjs-dist` 必须与宿主进程内其他插件一致：本机 `dsh-pdf-search` 用 6.3.289，混用会报 `API version does not match Worker version`。升级前先统一。
6. 发布后记得提示用户：插件要 `dsh plugin add` + 重启；**skill 要单独软链到 `<workspace>/.dsh/skills`**（打包系统不自动注册）。

## License

MIT。
