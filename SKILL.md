---
name: pdf-reader
description: 'Read a PDF (book, paper, manual) cheaply and accurately with the dsh-book-reader tools: page map/TOC, literal full-text search, then selective page reads (text first, images only when typography matters). Use whenever the user asks about specific pages, a section, a theorem, a figure, or "this page" in a PDF.'
---

# Reading a PDF with `dsh-book-reader`

Four tools, three cost tiers. **The default is text.** Images are a deliberate
expense, not the first move.

| Tool | Cost | Use for |
| --- | --- | --- |
| `pdf_info` | ~0 (text) | page count, printed↔physical offset, outline/TOC |
| `pdf_search` | ~0 (text) | locating a phrase, theorem number, or figure caption |
| `pdf_read_pages` + `include_image:false` | ~0 (text, per page) | prose, theorem statements, exercise text |
| `pdf_read_pages` (images on) | **~350–1024 tokens/page** | formulas, diagrams, tables, layout |
| `pdf_current_page` | ~0 | which page the user is looking at |

## Default loop (text-first)

1. `pdf_info` once per document → note `printedOffset` and the outline. Never
   hardcode an offset; it is detected (`printed = pdf − printedOffset`).
2. `pdf_search` for a distinctive phrase → page numbers.
3. `pdf_read_pages` with **`include_image:false`** to read those pages as text.
4. Only if the text is ambiguous or the question is about typography (a formula,
   a diagram, a table) → call again with images on, and crop.

## When images are worth it

- The question is about a **formula's exact form**, a **matrix layout**, a
  **diagram**, or **which theorem box** a sentence is in.
- Extracted text is known to garble math: `P_{n−1}(C)` becomes `𝒫 𝑛 − 1(𝐂)`,
  subscripts flatten, fractions collapse, theorem numbers split across lines.
- Prefer `crop` (`"0,0,1,0.55"` = top 55%) and `image_quality:"cheap"` (1.5×,
  ~350 tokens) unless dense subscripts need `scale:3`.

## Token economics (DeepSeek vision billing)

Each image is projected onto a 14 px patch grid, downsampled 3:1, and **capped at
1024 tokens**. For a 6×9 in book page:

| Render | Pixels | Tokens |
| --- | --- | --- |
| 1.5× (`image_quality:"cheap"`) | 563×954 | **347** |
| **2.5× (default)** | 938×1590 | **914** |
| 3× | 1125×1908 | 1002 (capped — no gain above ~2.7×) |

- Hard cap `maxPagesPerCall` (default **4**) is enforced before rendering.
- `pdf_read_pages` returns `imageTokens` and per-page `tokens`; check them.
- Images stay in the conversation and are re-billed on later turns. **Read once,
  then answer in text.**
- Never request `scale` above 3: the provider downscales to the same grid anyway.

## Page numbering

`pdf_info` returns `printedOffset` with `physical = printed + printedOffset`.
Tools accept either numbering; **printed is the default when detectable**.
Roman-numeral front matter has no numeric printed page — use
`page_numbers:"pdf"`. Say which numbering you mean when it is ambiguous.

## The injected reading position

At most one short line per turn may arrive as a user message, e.g.

```
[dsh-pdf-reader] 正在阅读《book》printed 132 (PDF 152) · Chapter 5 › 5B
```

It is a **position marker only**. The model decides whether to read anything.
Do not read a page just because the marker exists; read it when the question
needs it, and prefer `include_image:false` first.

## Pitfalls

- **Scanned PDFs** have no text layer: `pdf_search` finds nothing and
  `include_image:false` returns `textUnavailable`. Only images help.
- Errors are coded: `PDF_NOT_FOUND`, `PDF_NOT_FILE`, `PDF_ENCRYPTED`,
  `PDF_CORRUPT`, `PDF_READER_INVALID_PAGE`, `PDF_READER_INVALID_SCALE`,
  `PDF_RENDER_TIMEOUT`, `PDF_PAGE_TOO_LARGE`, `PDF_OUTSIDE_WORKSPACE`.
- **Tools are workspace-scoped by default.** Pass a path inside the session
  working directory; anything outside fails with `PDF_OUTSIDE_WORKSPACE` unless
  the user set `allowOutsideWorkspace: true`.
- `pdf_info` also reports `title`, `author`, `fileSizeBytes`, `pageSize` and
  `textCoverage` (`isLikelyScanned`). Check `textCoverage.isLikelyScanned`
  *before* searching: a scanned PDF has no text layer, so go straight to images.
- Search is literal: it does not unfold hyphenation and is not a regex engine.
- Page numbers are 1-based; relative paths resolve against the session directory.
- No annotation/note features: this plugin reads and renders only.

## Fallback (plugin disabled)

```sh
node -e "import('./lib/core/render.js').then(async m=>{const r=await m.renderPageToPng('<abs pdf>',344,{scale:2.5});require('fs').writeFileSync('/tmp/p344.png',r.buffer);console.log(r.width+'x'+r.height)})"
```

then `read_image('/tmp/p344.png')`. Slower, bypasses the attachment cache —
prefer the tools.
