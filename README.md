# dsh-book-reader

[![npm version](https://img.shields.io/npm/v/dsh-book-reader.svg)](https://www.npmjs.com/package/dsh-book-reader)
[![license](https://img.shields.io/npm/l/dsh-book-reader.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.x-blue)](https://github.com/deepseek-ai/deepseek-harness)

**Read PDFs in DSH together with the model.** A native toolbar on the official PDF preview, plus three tools the model can use to look up the TOC, search the full text, and read pages — page images included, when a formula or diagram needs to be seen.

[中文说明](README.zh-CN.md)

## Why this one

- **Native, not a replacement.** It decorates DSH's own PDF preview, so zoom, text selection, reload, and Office→PDF keep working. No extra viewer, no sidebar dependency.
- **The model can actually read the book.** Three tools give it the page map, text search, and page content, with page images only when needed.
- **It remembers where you were.** Reopening a book restores the last page and zoom.

## Quick start

1. DSH **Plugins → Add plugin** → `dsh-book-reader` (or `dsh plugin add dsh-book-reader`). Restart DSH.
2. Open any `.pdf` in the right sidebar — the toolbar appears in the preview header.
3. Ask the model about the PDF; it can search and read from now on.

Optional — give the model the reading guide (costs, page numbering, pitfalls):

```sh
ln -sfn "<installed package dir>" "<workspace>/.dsh/skills/pdf-reader"
```

## Features

| | Feature | What it does |
| --- | --- | --- |
| 🧭 | Navigation | Previous/next page, page readout, jump box (printed page, or `p152` for PDF page 152) |
| 🔎 | Search | Full-text search (`Cmd/Ctrl+F`) with in-page highlights; `Enter` / `Shift+Enter` jump between occurrences, no snippets |
| 🤖 | AI position hint | One short “you are reading page N” line per turn, only when the page changed (`AI●` toggle) |
| 💾 | Reading memory | Remembers page and zoom per book; restores them when you reopen it |
| 💬 | Tooltips | Hover/focus explanations on every control, English or Chinese |
| 🧰 | Model tools | `pdf_info`, `pdf_search`, `pdf_read_pages` — see below |

## Model tools

| Tool | Use it for | Cost |
| --- | --- | --- |
| `pdf_info` | Page count, printed↔physical page offset, outline/TOC | text, ~free |
| `pdf_search` | Finding a phrase, theorem number, or figure caption. Tolerates quotes/LaTeX, hyphen and math-notation splits, with keyword fallbacks; body pages first; optional `pages` range | text, ~free |
| `pdf_read_pages` | Reading chosen pages as text, optionally with page images | text ~free; images ~350–1024 tokens/page |

Example prompts:

> “What does chapter 5 of this book cover?” → `pdf_info` + `pdf_read_pages`
> “Find where ‘singular value’ appears.” → `pdf_search`
> “Search only chapter 7 (printed pp. 270–295) for ‘SVD’.” → `pdf_search` with `pages:"270-295"`
> “Show me the formula in theorem 5.6.” → `pdf_read_pages` with images

The model decides when text is enough and when an image is worth it.

## Configuration

Every key is optional and the defaults are safe. Common ones:

- `rememberView` (default `true`) — remember page/zoom per book.
- `maxPagesPerCall` (default `4`) — page cap per read call.
- `defaultScale` (default `2.5`) — image render scale (~180 DPI).
- `autoShare` (default `true`) — the AI position hint.

The full list with defaults is in [`cordis.patch.yml`](cordis.patch.yml).

## FAQ

**The toolbar does not appear.** Only `.pdf` previews get it (not `.docx`/`.pptx`/images). Update/reinstall the plugin and restart DSH.

**The model does not know my page.** The hint is sent at most once per turn and only when the page changed; turn on `AI●`, or mention the page in your message.

**Scanned PDFs.** No text layer: search finds nothing and text reads are empty. Page images still work — check `textCoverage.isLikelyScanned` from `pdf_info`.

**Search finds nothing.** Quotes and `$…$` are stripped, hyphen/math splits and missing spaces have fallbacks, and when no literal phrase matches the tool falls back to keyword AND (`mode` in the result says which pass matched). Try one short distinctive word.

**Does it modify my PDF?** No. It only reads and renders; nothing is written next to your books.

**Where is the remembered state?** In DSH's data directory (`~/.dsh/storages/book_reader_views.json`), at most 500 books, keyed by file path.

**A DSH upgrade broke the toolbar.** The toolbar relies on the preview's private DOM markers; page tools keep working regardless.

## Notes

- Local HTTP routes are loopback-only and unauthenticated; model tools stay inside the session workspace by default (`allowOutsideWorkspace` opts out).
- `pdfjs-dist` is pinned to `6.3.289` to match the DSH host process.

## More

[`SKILL.md`](SKILL.md) — the model's reading guide · [`CHANGELOG.md`](CHANGELOG.md) · [`LICENSE`](LICENSE) (MIT)
