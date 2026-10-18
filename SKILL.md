---
name: pdf-reader
description: Read a PDF (book, paper, manual) through the dsh-pdf-reader tools — page info/TOC, literal full-text search, and rendered page images. Use whenever the user asks about specific pages, a section, a theorem, a figure, or "this page" in a PDF, or wants a PDF indexed or searched.
---

# Reading a PDF

The `dsh-pdf-reader` plugin provides four model tools. They are cheap; use them instead of shelling out to pdftotext or guessing from file names.

| Tool | Cost | Use it to |
| --- | --- | --- |
| `pdf_info` | tiny (text) | page count, **printed↔physical page offset**, resolved **outline/TOC** |
| `pdf_search` | tiny (text) | find candidate pages by literal phrase |
| `pdf_read_pages` | **~350–1024 tokens/page** | actually *see* pages (returns image blocks) |
| `pdf_current_page` | tiny | which page the user is looking at right now |

## The loop that works

1. **`pdf_info`** once per document. Note `printedOffset` and skim the outline. Never hardcode an offset — it is detected per document (`printed = pdf − printedOffset`).
2. **`pdf_search`** to narrow down. Search is literal and does not unfold hyphenation; try a distinctive phrase, not a formula.
3. **`pdf_read_pages`** for only the 1–4 pages you actually need, then answer from what you see.
4. When the user says "this page" / "当前页" / "what I'm looking at" → **`pdf_current_page`** (or just use the reading-position line the plugin injects automatically).

## Cost control (important)

DeepSeek vision billing projects each image onto a 14 px-patch grid with 3:1 downsampling, `tokens = gridH × (gridW + 1) + 2`, **capped at 1024 tokens per image**. A page at the default 2.5× scale costs **~900 tokens**; it can never exceed 1024.

- `image_quality: "cheap"` (1.5×) ≈ **347 tokens** — enough for prose, not dense subscripts.
- Default 2.5× ≈ **914 tokens** — best readable quality per token. **Do not request scale above 3**: the provider downscales it back to the same grid, so you pay latency for nothing.
- `crop` (e.g. `{x:0,y:0,w:1,h:0.55}`) keeps only the region you need and cuts the bill.
- Hard cap `maxPagesPerCall` (default 4). Don't stream a whole chapter as images: search first, read the few pages that matter.
- Images persist in the conversation and are re-billed on later turns. Read once, then summarise in text.

## Page numbering

`pdf_info` returns `printedOffset` with `physical pdf page = printed page + printedOffset`. Tools and the UI default to **printed** numbers when an offset exists; a PDF without numeric page labels falls back to physical pages. Say which numbering you mean when it is ambiguous.

## Pitfalls

- **Extracted text garbles math** (`𝒫 𝑛 − 1(𝐂)` for `P_{n−1}(C)`, flattened subscripts, theorem numbers split across lines). Use text only to *locate*; use `pdf_read_pages` to *read* formulas.
- **Scanned PDFs** have no text layer: `pdf_search` legitimately finds nothing — go straight to `pdf_read_pages`.
- Errors are coded: `PDF_NOT_FOUND`, `PDF_ENCRYPTED`, `PDF_CORRUPT`, `PDF_READER_INVALID_PAGE`.
- Page numbers are 1-based everywhere.
- No note-taking/annotation — this plugin only reads and renders.

## Fallback (plugin not enabled)

Render directly with the bundled core, then look at the PNG:

```sh
node -e "import('./lib/core/render.js').then(async m=>{const r=await m.renderPageToPng('<abs pdf>',344,{scale:2.5});require('fs').writeFileSync('/tmp/p344.png',r.buffer);console.log(r.width+'x'+r.height)})"
```

then `read_image('/tmp/p344.png')`. Slower, bypasses the attachment cache — prefer the tools.
