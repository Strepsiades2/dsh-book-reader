# dsh-book-reader

[![npm version](https://img.shields.io/npm/v/dsh-book-reader.svg)](https://www.npmjs.com/package/dsh-book-reader)
[![license](https://img.shields.io/npm/l/dsh-book-reader.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.x-blue)](https://github.com/deepseek-ai/deepseek-harness)

**在 DSH 里和模型一起读 PDF。** 官方 PDF 预览上加一条原生工具栏，并给模型三个工具：查目录、全文搜索、读指定页——公式和图表需要时还能直接看页面图片。

[English](README.md)

## 为什么用它

- **原生，不替换。** 装饰 DSH 自己的 PDF 预览器，缩放、选中、刷新、Office→PDF 都保持原样；不额外装阅读器、不依赖侧边栏插件。
- **模型真的能读这本书。** 三个工具给它页码/目录、文本搜索和页面内容；只有需要看公式、图表时才花图片 token。
- **记住你读到哪。** 再次打开同一本书，自动回到上次的页码和缩放。

## 三步上手

1. DSH 的 **Plugins → Add plugin** → `dsh-book-reader`（或 `dsh plugin add dsh-book-reader`），重启 DSH。
2. 在右侧栏打开任意 `.pdf`，预览头部出现工具栏。
3. 直接问模型关于这本书的问题，它就能自己搜、自己读。

可选——把阅读指南交给模型（成本、页码规则、常见坑）：

```sh
ln -sfn "<已安装的包目录>" "<workspace>/.dsh/skills/pdf-reader"
```

## 功能

| | 功能 | 说明 |
| --- | --- | --- |
| 🧭 | 翻页与跳页 | 上一页/下一页、跟随滚动的页码读数、跳页框（印刷页码，或 `p152` 表示 PDF 第 152 页） |
| 🔎 | 全文搜索 | `Cmd/Ctrl+F` 打开搜索，命中文字在页面上高亮；`Enter` / `Shift+Enter` 在命中之间顺序跳转，不显示摘要 |
| 🤖 | AI 位置提示 | 每轮对话最多一行“你正在看第 N 页”，页码变了才发（`AI●` 开关） |
| 💾 | 阅读记忆 | 按书记住页码和缩放，重新打开时恢复 |
| 💬 | 悬停说明 | 每个控件都有悬停/聚焦提示，跟随 DSH 界面语言（中/英） |
| 🧰 | 模型工具 | `pdf_info`、`pdf_search`、`pdf_read_pages`，见下 |

## 模型工具

| 工具 | 用途 | 成本 |
| --- | --- | --- |
| `pdf_info` | 页数、印刷页↔物理页偏移、目录/TOC | 文本，几乎免费 |
| `pdf_search` | 找短语、定理编号、图表标题。容忍引号/LaTeX、连字符与数学符号拆分，支持关键词回退；正文页优先 | 文本，几乎免费 |
| `pdf_read_pages` | 读指定页的文本，可选返回页面图片 | 文本几乎免费；图片约 350–1024 token/页 |

可以这样问：

> “这本书第 5 章讲了什么？” → `pdf_info` + `pdf_read_pages`
> “找一下 singular value 出现在哪几页。” → `pdf_search`
> “把定理 5.6 的公式截给我看。” → `pdf_read_pages` 带图片

什么时候用文本、什么时候值得花图片 token，由模型自己判断。

## 配置

全部可选，默认值即安全值。常用：

- `rememberView`（默认 `true`）—— 按书记住页码/缩放。
- `maxPagesPerCall`（默认 `4`）—— 单次读页上限。
- `defaultScale`（默认 `2.5`）—— 图片渲染倍率（约 180 DPI）。
- `autoShare`（默认 `true`）—— AI 位置提示。

完整键和默认值见 [`cordis.patch.yml`](cordis.patch.yml) 注释。

## 常见问题

**看不到工具栏？** 只有 `.pdf` 预览会挂工具栏（`.docx`/`.pptx`/图片不会）。升级/重装插件后重启 DSH。

**模型不知道我在哪一页？** 位置提示每轮最多一次、页码变了才发；打开 `AI●`，或直接在消息里提页码。

**扫描件？** 没有文本层：搜索为空、文本读页为空；页面图片仍然可用，先用 `pdf_info` 的 `textCoverage.isLikelyScanned` 判断。

**搜索找不到东西？** 引号和 `$…$` 会被去掉，连字符/数学符号拆分、缺空格有回退；整句没有字面命中时会退化成关键词 AND 搜索（结果的 `mode` 会说明命中方式）。试一个更短、更独特的词。

**会改我的 PDF 吗？** 不会。只读取和渲染，不会往书目录写任何东西。

**记住的状态存哪？** DSH 数据目录下的 `~/.dsh/storages/book_reader_views.json`，按文件路径索引，最多保留 500 本。

**DSH 升级后工具栏失效？** 工具栏依赖预览器的私有 DOM 标记；即使失效，模型工具仍然可用。

## 说明

- 本地 HTTP 路由只认回环地址、无鉴权；模型工具默认只在会话工作区内读取（可设 `allowOutsideWorkspace`）。
- `pdfjs-dist` 锁定 `6.3.289`，与 DSH 宿主进程保持一致。

## 更多

[`SKILL.md`](SKILL.md) —— 模型使用手册 · [`CHANGELOG.md`](CHANGELOG.md) · [`LICENSE`](LICENSE)（MIT）
