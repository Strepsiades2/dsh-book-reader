# dsh-book-reader

A reading toolbar for DSH's official PDF preview, plus three PDF tools the model can use.

[中文说明](README.zh-CN.md)

## Features

**Reading toolbar** — only on `.pdf` previews in the right sidebar; the stock previewer is untouched.

- Previous/next page, a current-page readout, and a jump box (printed page numbers, or `p152` for PDF page 152).
- Full-text search with `Cmd/Ctrl+Shift+F`; click a result to jump, or insert its page reference into the chat.
- AI position hint: before each turn the model may receive one short “you are reading page N” line (the `AI●` toggle, on by default).
- **Remembers your place**: reopening a book restores the last page and zoom. State is stored by DSH per book and survives restarts.
- Hover/focus explanations on every control, in English or Chinese.

**Model tools** — the model calls them when you ask about a PDF.

| Tool | What it does |
| --- | --- |
| `pdf_info` | Page count, printed↔physical page offset, outline/TOC |
| `pdf_search` | Literal full-text search; page numbers and snippets |
| `pdf_read_pages` | Reads chosen pages as text, optionally with page images |

## Install

1. **Plugins → Add plugin** in DSH and enter `dsh-book-reader` (or run `dsh plugin add dsh-book-reader`).
2. Restart DSH after installing or upgrading.
3. Optional: give the model the reading guide by linking the skill into your workspace:

   ```sh
   ln -sfn "<installed package dir>" "<workspace>/.dsh/skills/pdf-reader"
   ```

## Configuration

All keys are optional and the defaults are safe. Common ones:

- `rememberView` (default `true`) — remember page/zoom per book.
- `maxPagesPerCall` (default `4`) — page cap for `pdf_read_pages`.
- `defaultScale` (default `2.5`) — image render scale.
- `autoShare` (default `true`) — the AI position hint.

The full list with defaults is in [`cordis.patch.yml`](cordis.patch.yml).

## Notes

- Only the official PDF preview is supported; the toolbar relies on that preview's private DOM markers, so a DSH upgrade may change behavior.
- Tools read only inside the session workspace unless `allowOutsideWorkspace` is set; the local HTTP routes are loopback-only and unauthenticated.
- Scanned PDFs have no text layer — page images are the only option (no OCR).
- `pdfjs-dist` is pinned to `6.3.289` to match the host process.

## More

[`SKILL.md`](SKILL.md) — the model's reading guide · [`CHANGELOG.md`](CHANGELOG.md) · [`LICENSE`](LICENSE) (MIT)
