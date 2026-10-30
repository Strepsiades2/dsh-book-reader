# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Page-text truncation no longer splits a surrogate pair. `trimPageText` cut at
  `maxTextCharsPerPage` with `slice()`; a math bold glyph (U+1D400 and above) at
  the cut left a lone high surrogate, and one such tool result made every later
  DeepSeek Messages request fail with `400 INVALID_REQUEST`. Truncation now backs
  off a split pair, and every rendered tool-result string (page blocks, header,
  search snippets) is re-checked for well-formed Unicode at the output boundary.

## [0.3.3] — 2026-10-29

### Fixed

- Page geometry is no longer measured while the PDF preview is scrolling. The
  O(410) rect pass used to run on every lazy page render (ResizeObserver),
  forcing a full preview layout against PDF.js and leaving a grey placeholder
  for seconds at high zoom on Retina displays. Measurements now run ~260 ms
  after scrolling stops, are skipped entirely while the saved page/zoom restore
  is in flight, and page wrappers are cached between passes.
- PDF text, search snippets, outline titles and document metadata are now
  returned as well-formed Unicode. Some pages' fonts make PDF.js emit an
  unpaired UTF-16 surrogate (for example `U+D835`); that string is valid JSON
  but invalid for the model API, and a single such tool result in a Session log
  made every later DeepSeek Messages request fail with `400 INVALID_REQUEST`.
  Unpaired surrogates are replaced with `U+FFFD` (length-preserving, so search
  offsets stay aligned).
## [0.3.2] — 2026-10-23

### Fixed

- `pdf_read_pages` is now registered synchronously with the other two tools
  instead of waiting for the `attachments` injection. The later registration
  made DSH announce `已添加工具：pdf_read_pages` at the start of every chat;
  image calls still resolve the attachment store lazily, and text-only calls
  never need it.
## [0.3.1] — 2026-10-22

### Fixed

- Text-only `pdf_read_pages` calls (`include_image:false`) no longer crash while
  rendering their output, and they no longer require an image-capable model
  route or the attachment store; image reads still require both.
## [0.3.0] — 2026-10-20

### Changed

- Search is now a basic in-page find bar: `Cmd/Ctrl+F` opens it, matches are
  highlighted on the PDF text layer, and `Enter` / `Shift+Enter` (or the
  previous/next buttons) jump between occurrences with an `n / total` counter.
- The search result list, its snippets, and the per-result “→ AI” insertion are
  gone; search no longer inserts anything into the composer.
- `pdf_search` is now normalized text search: wrapping quotes/backticks and
  `$…$` are stripped, NFKC folds math alphanumerics and ligatures, dashes and
  line-break hyphenation are removed, and if no literal phrase matches it falls
  back to a space-insensitive pass (`compact`) and then keyword AND (`terms`).
  The result gains `mode`; hits rank body pages before front matter (at most 3
  front-matter hits), `pages` counts every matched page, and the tool default
  limit is 30. The tool description now states these rules so the model stops
  passing quoted or LaTeX-marked phrases.
- `pdf_search` accepts an optional `pages` selection (the same syntax as
  `pdf_read_pages`; printed pages by default, `page_numbers:"pdf"` for physical
  pages) to scan only a page range and report matches inside it. This keeps a
  late-chapter search from being crowded out by earlier pages.

### Fixed

- Opening a book now jumps to the remembered page immediately, before a saved
  fixed zoom is replayed, so the cover no longer flashes for a few hundred
  milliseconds while the zoom settles. The scroll is re-applied after the zoom
  commit so the page stays aligned.
- `pdf_read_pages` no longer disappears from the model's tool list: its output
  schema used a property-level `required: false`, which DSH's `defineTool`
  rejects at registration time. The exception only reached the Host log, so the
  plugin looked enabled with two tools instead of three.
## [0.2.0] — 2026-10-20

### Added

- View-state memory: the toolbar remembers the last page and zoom ratio per PDF
  and restores them when the same book is reopened. The state is stored by the
  Host in the `book_reader_views` storage domain through `ctx.storageDomain`
  (schema-validated JSON under the DSH data directory), survives DSH restarts,
  and degrades silently when that service is unavailable.
- New config key `rememberView` (default `true`).
- Host routes `GET /dsh-pdf-reader/view?path=…` and
  `POST /dsh-pdf-reader/view` for the browser half.
- Docs: the README is split into an English `README.md` and a Simplified Chinese
  `README.zh-CN.md`, both rewritten in a product-page style (badges, quick start,
  feature table, model-tool examples, FAQ, data/privacy notes).
## [0.1.1] — 2026-10-18

### Changed

- Simplified, feature-focused README (English + 中文) that leads with what the
  plugin does instead of full internals documentation.
- The automatic reading-position hint is now sent **at most once per turn**, and
  only when the page changed. The per-step guard and the 3-minute default
  throttle are gone: `autoShareMinSteps` was removed and
  `autoShareMinIntervalMs` now defaults to `0` (optional extra throttle).
- Repository, homepage, and issue links now point to
  `github.com/Strepsiades2/dsh-book-reader`.

### Removed

- The `pdf_current_page` tool. The per-turn position hint (or a page reference
  you insert yourself) now covers “which page am I on”, leaving three tools:
  `pdf_info`, `pdf_search`, and `pdf_read_pages`.
- The toolbar's manual “insert current page reference” (↗) button. The
  automatic per-turn position hint already tells the model the current page, so
  the button was redundant. The search panel's per-result “→ AI” insertion
  remains.
## [0.1.0] — 2026-10-18

First public release.

### Added

- Toolbar controls on DSH's official PDF preview: previous/next page, printed
  and physical page readout with a jump box, full-text search panel
  (`Cmd/Ctrl+Shift+F`), share-page reference insertion, and an AI reading-position
  toggle.
- Hover explanations for every toolbar control, in the active DSH UI language
  (English and Simplified Chinese).
- Four model-facing tools: `pdf_info` (page map and outline), `pdf_search`
  (literal full-text search), `pdf_read_pages` (text first, optional page
  images), and `pdf_current_page` (what the user is reading).
- Per-turn reading-position injection behind `agent/pre-step`, debounced and
  rate-limited.
- Local JSON routes for the browser half, loopback-only and restricted by
  `routeAllowedRoots` / the session workspace by default.
- Bundle display metadata: localized title/description and an SVG icon for the
  DSH Plugins page.

### Notes

- Depends on the official preview's private DOM markers; DSH upgrades may change
  them.
- `pdfjs-dist` is pinned to `6.3.289` to match the host process.
- MIT licensed.

[0.3.3]: https://github.com/Strepsiades2/dsh-book-reader/releases/tag/v0.3.3
[0.3.2]: https://github.com/Strepsiades2/dsh-book-reader/releases/tag/v0.3.2
[0.3.1]: https://github.com/Strepsiades2/dsh-book-reader/releases/tag/v0.3.1
[0.3.0]: https://github.com/Strepsiades2/dsh-book-reader/releases/tag/v0.3.0
[0.2.0]: https://github.com/Strepsiades2/dsh-book-reader/releases/tag/v0.2.0
[0.1.1]: https://github.com/Strepsiades2/dsh-book-reader/releases/tag/v0.1.1
[0.1.0]: https://github.com/Strepsiades2/dsh-book-reader/releases/tag/v0.1.0
