# dsh-book-reader

给 DSH 官方 PDF 预览加一条读书工具栏，并给模型三个 PDF 工具。

[English](README.md)

## 功能

**阅读工具栏** —— 只在右侧栏的 `.pdf` 预览上出现，不替换官方预览器。

- 上一页/下一页、跟随滚动的页码读数、跳页框（印刷页码，或 `p152` 表示 PDF 第 152 页）。
- 全文搜索（`Cmd/Ctrl+Shift+F`）：点结果跳页，或把该页引用插入对话框。
- AI 位置提示：每轮对话开始前，模型可能收到一行“你正在看第 N 页”的短提示（`AI●` 开关，默认开）。
- **记住阅读位置**：再次打开同一本书时恢复上次的页码和缩放；状态按书保存在 DSH 侧，重启后仍有效。
- 每个控件都有悬停/聚焦说明，跟随 DSH 界面语言（中文或英文）。

**模型工具** —— 你问 PDF 内容时由模型调用。

| 工具 | 作用 |
| --- | --- |
| `pdf_info` | 页数、印刷页↔物理页偏移、目录/TOC |
| `pdf_search` | 字面全文搜索；返回页码和摘要 |
| `pdf_read_pages` | 读取指定页的文本，也可返回页面图片 |

## 安装

1. DSH 的 **Plugins → Add plugin** 输入 `dsh-book-reader`（或命令行 `dsh plugin add dsh-book-reader`）。
2. 安装或升级后重启 DSH。
3. 可选：把 skill 软链到工作区，让模型拿到阅读流程说明：

   ```sh
   ln -sfn "<已安装的包目录>" "<workspace>/.dsh/skills/pdf-reader"
   ```

## 配置

全部可选，默认值即安全值。常用：

- `rememberView`（默认 `true`）—— 按书记住页码/缩放。
- `maxPagesPerCall`（默认 `4`）—— 单次读页上限。
- `defaultScale`（默认 `2.5`）—— 图片渲染倍率。
- `autoShare`（默认 `true`）—— AI 位置提示。

完整键和默认值见 [`cordis.patch.yml`](cordis.patch.yml) 注释。

## 说明

- 只支持官方 PDF 预览；工具栏依赖该预览的私有 DOM 标记，DSH 升级可能影响行为。
- 工具默认只在会话工作区内读取（可设 `allowOutsideWorkspace`）；本地 HTTP 路由只认回环地址、无鉴权。
- 扫描件没有文本层，只能看图（没有 OCR）。
- `pdfjs-dist` 锁定 `6.3.289`，以和宿主进程一致。

## 更多

[`SKILL.md`](SKILL.md) —— 模型使用手册 · [`CHANGELOG.md`](CHANGELOG.md) · [`LICENSE`](LICENSE)（MIT）
