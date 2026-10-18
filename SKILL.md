---
name: pdf-reader
description: Locate pages in a PDF and show them to the vision model as rendered images. Use when the user asks about specific pages, sections, theorems, or figures in a PDF, especially a math or technical book whose extracted text garbles formulas.
---

# Reading a PDF with your eyes, not just its text layer

Raw PDF text extraction is useful for finding *where* something is and nearly
useless for reading mathematics: superscripts and subscripts flatten, fractions
collapse to one line, blackboard-bold and calligraphic letters become private-use
glyphs, and theorem numbers split across lines. The reliable loop is:

1. **Locate** the page with the outline and text search.
2. **Confirm** the physical-page → printed-page offset.
3. **Render** the page range to PNG.
4. **Look** at the PNG with `read_image`, and crop if the type is small.

Do not explain a formula from extracted text alone when a rendered page can be
read instead.

## Tool

This skill ships a macOS PDFKit helper: `pdfkit` (Swift, no runtime
dependencies). Set its path once per shell:

```sh
PDFKIT="$PWD/dsh-pdf-reader/tools/pdfkit"
test -x "$PDFKIT" || echo "missing: build it with the recipe at the end of this file"
```

Subcommands:

```text
pdfkit info   <pdf>                                  # pages, page labels, TOC with both page numbers
pdfkit text   <pdf> [--pages 1-20,25] [--out file]   # per-page text (cheap, but math is mangled)
pdfkit search <pdf> --query "term" [-i] [--context 60]
pdfkit render <pdf> --pages 292-293 [--scale 2] [--out dir] [--prefix name]
pdfkit render <pdf> --pages 293 --scale 3 --crop 0,0,1,0.55   # top half, fractions
```

Page numbers are always **1-based physical PDF pages**. That is not the number
printed on the page; step 2 resolves the difference.

## Workflow

### 1. Locate with the outline first

```sh
"$PDFKIT" info "Linear Algebra Done Right-Springer (2024).pdf"
```

Read `outline:` — it lists every chapter and section with `p<N> · printed <label>`.
Prefer this over searching when the user names a section, theorem, or topic from
the table of contents. If the outline is missing or unhelpful, search:

```sh
"$PDFKIT" search "Linear Algebra Done Right-Springer (2024).pdf" \
  --query "singular value decomposition" --ignore-case
```

Each hit is prefixed with its physical page (`p290`), so it maps directly to
`render --pages`. Exit code 3 means no hits.

For repeated queries in one book, cache the text once and grep it:

```sh
mkdir -p .tmp/pdf-index
"$PDFKIT" text "book.pdf" --out .tmp/pdf-index/book.txt
grep -n -i "minimal polynomial" .tmp/pdf-index/book.txt
```

Then read the nearest `===== PAGE <n> =====` marker above the hit. This is fast
and costs no model context; it is an index, not evidence about typography.

### 2. Confirm the printed-page offset

`info` prints a line such as:

```text
printed-page-offset: physical = printed + 20  (390 numeric labels agree)
```

Use this to translate what the user says ("page 272") into a render target
(physical 292), and to report both when answering. Front matter roman numerals
do not follow the offset. Never assume the offset is the same in another book —
run `info` for each file. Verify a boundary page when it matters: render the
target and check the running head/footer in the image.

### 3. Render the page range

```sh
"$PDFKIT" render "Linear Algebra Done Right-Springer (2024).pdf" \
  --pages 292-293 --scale 2 --out .tmp/pdf-pages --prefix ladr
```

- `--scale 2` produces roughly 144 DPI (a 375×636 pt page becomes 750×1272 px).
  This is the default and is enough for body text and most display math.
- `--scale 3` is for dense sub/superscripts, but a full page then exceeds the
  model's per-image budget and is downscaled again. Prefer `--crop` at 3×.
- `--crop x0,y0,x1,y1` takes fractions with a **top-left** origin. Use it to
  zoom into the relevant band: `--crop 0,0,1,0.55` is the top 55% of the page,
  `--crop 0,0.45,1,1` the bottom 55%.
- Keep output under `.tmp/` in the workspace; delete it when the task ends.

### 4. Look at each image

Call the session's image-reading tool (`read_image`) with the printed PNG path,
one page at a time:

```text
read_image .tmp/pdf-pages/ladr-292.png
read_image .tmp/pdf-pages/ladr-293.png
```

Before generating images for inspection, establish that the current model
accepts image input (the session's `read_image` tool exists and the routed model
declares image input). If it does not, say so and fall back to extracted text;
do not render and then guess.

Two or three pages per turn is usually the right budget. Read the image, quote
the formula or theorem from what you actually see, and cite **both** the physical
and printed page numbers.

## Pitfalls

- **Printed page ≠ PDF page.** In the bundled LADR book the offset is +20
  (physical 292 = printed 272). `info` computes it; do not hard-code it.
- **Text extraction mangles math.** `pdfkit text` is for locating and for prose.
  It renders `P_{n-1}` as `𝒫 𝑛 − 1(𝐂)`, loses fraction bars, and can split
  theorem labels. Never reconstruct a displayed equation from it.
- **Page labels are inconsistent in front matter.** The cover, blanks, and roman
  pages do not share the body offset. Use an outline destination or a search hit;
  do not derive a page from the printed label alone.
- **Lazy rendering in the GUI.** The right-sidebar preview draws only pages near
  the viewport. Scrolling to a page is what makes it render; a screenshot of an
  off-screen placeholder is blank.
- **Image budgets.** A full-page render is scaled down by the provider when it
  exceeds the request image budget. Small subscripts can disappear; crop the
  relevant region instead of raising the whole-page scale.
- **Scanned PDFs have no text layer.** `text` prints
  `[no text layer — likely a scanned page; render it instead]`; go straight to
  rendering, and say that the text index is unavailable.
- **Do not modify the source PDF.** Renders are disposable artifacts.

## Building the helper (macOS)

The file sandbox blocks the default clang module cache under `/var/folders`, so
both `TMPDIR` and `-module-cache-path` must point inside the workspace:

```sh
mkdir -p .tmp .swiftcache
TMPDIR="$PWD/.tmp" swiftc -module-cache-path "$PWD/.swiftcache" -O \
  dsh-pdf-reader/tools/pdfkit.swift -o dsh-pdf-reader/tools/pdfkit
```

Requires macOS with PDFKit (system framework). On non-macOS hosts, use the
`office-render` skill's LibreOffice Kit PDF rasterizer, or a package such as
`dsh-pdf` / `dsh-pdf-reader` that exposes PDF tools, and keep the same
locate → confirm offset → render → `read_image` loop.
