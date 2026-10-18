# dsh-book-reader core (`lib/core`)

Pure-Node core for the AI-side half of `dsh-book-reader`: open a PDF, extract
text, search it, and render pages to PNG **in-process**. No browser, no Swift,
no PDFKit, no Python, no shelling out.

```
lib/core/pdf.js      document cache, info/labels/offset/outline, page text, search
lib/core/render.js   page -> RGB PNG Buffer (pdf.js + @napi-rs/canvas)
test/core.test.mjs   plain-node tests against the real LADR books
```

Tested on macOS arm64 with Node **24.14.0**, `pdfjs-dist@6.4.299`,
`@napi-rs/canvas@1.0.11`. `pdfjs-dist@6.4.299` requires Node >= 22.13.

## Dependencies

Declared in `package.json` (do not duplicate them elsewhere):

```json
"dependencies": {
  "@napi-rs/canvas": "^1.0.11",
  "pdfjs-dist": "^6.4.299"
}
```

The host is expected to import these core modules in a normal Node ESM context
where those packages resolve. If the host bundles, keep both packages external
(the native canvas binary cannot be bundled as JavaScript, and pdf.js must be
able to import its own `pdf.worker.mjs`).

## Public interface

```js
// lib/core/pdf.js
export async function getInfo(path)
// -> { path, pageCount, labels: [{pdf, printed}], printedOffset: number|null,
//      outline: [{ title, pdf, printed, depth }] }

export async function getPageText(path, pdfPage)      // -> string
export async function searchPdf(path, query, opts)    // opts: {ignoreCase=true, limit=200, contextChars=80}
// -> { hits: [{ pdf, printed, indexOnPage, snippet }], pages: <number of pages with hits> }
export async function closePdf(path)                  // optional cache eviction -> boolean

// lib/core/render.js
export async function renderPageToPng(path, pdfPage, opts)  // opts: {scale=2, crop}
// crop = {x,y,w,h} fractions of the page, e.g. {x:0,y:0,w:1,h:0.55}
// -> { pdf, printed, buffer, width, height }

export async function renderPagesToPng(path, pages, opts)   // -> array of the above
```

### `getInfo(path)`

Returns a fresh (mutable) copy on every call; mutating it cannot poison the
cache.

* **`path`** — absolute filesystem path. Relative paths are resolved against
  `process.cwd()`; `file://` URLs are accepted. The returned `path` is the
  resolved absolute path.
* **`pageCount`** — `doc.numPages` (410 for the LADR book).
* **`labels`** — one entry per physical page when the PDF has page labels:
  `[{pdf: 1, printed: 'C1'}, {pdf: 21, printed: 1}, ...]`. If
  `getPageLabels()` returns no labels, `labels` is `[]`.
* **`printed` type** — `number` for numeric labels (`1`, `324`), the raw
  string for non-numeric labels (`"i"`, `"xvii"`, `"C1"`), `null` for an
  unlabelled page. This keeps front matter meaningful instead of emitting
  negative numbers.
* **`printedOffset`** — **`physical PDF page - printed page`**:
  **20** for LADR, **1** for `LADR_Solutions.pdf`. Therefore
  `printed = pdf - printedOffset`. It is detected from the mode of the
  per-page deltas among numeric `pageLabels`; `null` when there are no numeric
  labels. The mode is not hardcoded per book.
* **`outline`** — flattened depth-first. Root entries have `depth: 0`, their
  children `depth: 1`, etc. Every entry has a resolved 1-based physical `pdf`
  page. Entries whose destination cannot be resolved are dropped rather than
  throwing; an unresolved parent does not prevent resolved children from
  appearing. `printed` follows the same number/string rule as labels.
  LADR resolves **169** entries.

### `getPageText(path, pdfPage)`

Returns the page's text as **one whitespace-normalised line** (runs joined
with a single space, all whitespace collapsed, trimmed). This is deliberate: it
makes phrases such as `8.46 Jordan form` searchable across PDF text runs. It is
not a layout-preserving extraction; use render for formulas/typography.

`pdfPage` is 1-based and must be in `1..pageCount` (numeric strings are
accepted). Invalid pages throw a `RangeError` with
`code = 'PDF_PAGE_OUT_OF_RANGE'`.

### `searchPdf(path, query, opts)`

Literal, substring search (the query is not a regex). Both the query and each
page's text are whitespace-normalised; `ignoreCase` defaults to `true`.
Matching is non-overlapping, page by page, with an `await` between pages so the
event loop is not held for the whole book.

* `hits` are ordered by physical page, then position on the page.
* `printed` is the printed label for that page (`273` for PDF page 293), or a
  front-matter string / `null`.
* `indexOnPage` is a UTF-16 offset into the **same normalised text** that
  `getPageText()` returns for that page.
* `snippet` is at most about `2 * contextChars + query.length` characters, with
  leading/trailing `…` when the hit is mid-page.
* `limit` caps the number of collected hits (default 200), but the scan
  continues to the last page so `pages` always counts **all** pages with at
  least one hit. LADR's `"singular value decomposition"`: 56 hits on 28 pages,
  including PDF 293 / printed 273.
* `contextChars` defaults to 80.

An empty/whitespace-only query throws `TypeError`. Invalid `limit`/`contextChars`
throw `RangeError`.

### `closePdf(path)`

Evicts the cached document for `path` and destroys its pdf.js loading task.
Returns `true` when an entry existed, `false` otherwise (idempotent). If a call
is still using the document, it stays alive until that call releases it; this
function does not wait for in-flight renders. Memory is reused by later opens;
RSS may not immediately shrink because the native allocator retains arenas.

### `renderPageToPng(path, pdfPage, opts)` / `renderPagesToPng(path, pages, opts)`

* **Output** — `{pdf, printed, buffer, width, height}` where `buffer` is a Node
  `Buffer` containing an **8-bit RGB PNG (PNG color type 2)** on an opaque
  white background. It is not RGBA. Dimensions are the exact PNG dimensions.
* **`scale`** — a number in **1..3**; default `2`. Out-of-range scales throw a
  `RangeError` (no silent clamping). At scale 2 the LADR page is 750x1272.
* **`crop`** — `{x, y, w, h}` fractions of the rendered page; omitted values
  default to `x=0, y=0, w=1-x, h=1-y`. Must satisfy `x,y >= 0`, `w,h > 0`,
  `x+w <= 1`, `y+h <= 1`. The PNG is cropped after a full-page render, so crop
  does not reduce render time; it reduces the encoded image and reported
  dimensions. `{x:0,y:0,w:1,h:0.55}` at scale 2 is 750x700.
* **`renderPagesToPng`** accepts an array of pages (also a single number) and
  preserves order. Empty array -> `[]` without opening the PDF. Rendering is
  limited to **2 pages at a time** by a module-wide semaphore, including
  concurrent single-page calls, so memory spikes stay bounded.
* Each page's pdf.js operator list is cleaned up after the pixels are captured.
  This keeps long render sessions bounded (70 pages: ~243 MB RSS instead of
  ~283 MB without cleanup), at the cost of a re-parse (~8 ms) if the same page
  is rendered again.
* Pages are rendered with `@napi-rs/canvas`; the PNG is encoded by a small
  hand-written RGB encoder because the native canvas encoder emits RGBA.

## Errors

All open failures are normal `Error`s with a machine-readable `code`:

| code | meaning |
| --- | --- |
| `PDF_NOT_FOUND` | path does not exist (or is not a file) |
| `PDF_NOT_READABLE` | permission denied |
| `PDF_NOT_FILE` | path exists but is not a regular file |
| `PDF_ENCRYPTED` | encrypted/password-protected; no password support by design |
| `PDF_CORRUPT` | invalid PDF structure |
| `PDF_UNREADABLE` | pdf.js could not retrieve the data (usually a bad path) |
| `PDF_LOAD_TIMEOUT` | whole-document load exceeded 60 s |
| `PDF_LOAD_FAILED` | other open/parse failure (original error in `cause`) |
| `PDF_PAGE_OUT_OF_RANGE` | bad 1-based page number |
| `PDF_TEXT_EXTRACTION_FAILED` | a page's text layer failed to extract |

Encrypted and corrupt PDFs reject promptly; the load guard is 60 s
(`PDF_LOAD_TIMEOUT_MS`). There is no timeout on individual text extraction or
rendering; pdf.js either completes or rejects those.

## Cache

* Cache key: resolved path, validated on every call against `mtimeMs + size`.
  If the file is replaced, the old document is retired and a new one opened.
* Capacity: **4 open documents**. Least-recently-used documents are retired and
  their loading tasks destroyed. Documents with an active call are skipped
  until they are released; the cache may briefly exceed 4 under heavy parallel
  use and trims as calls finish.
* Cached per document: pdf.js document, labels/offset metadata, resolved info
  (outline), and pdf.js's own page cache. Page text and PNGs are **not**
  cached; each search/render re-extracts, so memory stays predictable.
* `closePdf()` is the explicit eviction hook. The cache is per Node process
  (per worker thread); it is not shared across processes or hosts.

## Measured numbers

macOS arm64 (Apple Silicon), Node 24.14.0, `pdfjs-dist@6.4.299`,
`@napi-rs/canvas@1.0.11`. LADR = 410-page
`Linear Algebra Done Right-Springer (2024).pdf`. "Cold" is the first
`getInfo` in a fresh process; "warm" is a repeat call while the document is
cached. Medians over repeated runs; timings move with machine load (search in
particular ranged from ~0.67 s to ~1.18 s across runs).

| Operation | Measured |
| --- | --- |
| Cold `getInfo` (open + labels + 169-entry outline) | **~85-105 ms** |
| First PDF call if only `pdf.js` was imported and neither canvas nor pdf.js was loaded yet | **~156 ms** |
| Warm `getInfo` | **~0.05 ms** median |
| `getPageText(344)` | **~28-50 ms** |
| `searchPdf` over all 410 pages (`"singular value decomposition"`) | **~0.8 s** median; 0.67-1.18 s observed |
| `renderPageToPng(344, scale 2)` | **~26 ms** median warm (22-43 ms) |
| `renderPagesToPng([344,345,346], scale 2)` | **~66 ms** median (63-77 ms) |
| Cropped render (`0,0,1,0.55`, scale 2) | **~18-27 ms** |
| PNG size, page 344 scale 2 | 210,422 bytes, 750x1272, RGB |
| Encrypted / corrupt PDF rejection | 1-125 ms (first parse may be slower) |

Memory (RSS, `--expose-gc`, after forced GC):

| State | RSS |
| --- | --- |
| Both core modules imported, nothing opened | ~82 MB |
| 410-page book opened + info | ~130 MB |
| Small 39-page PDF additionally open | ~134 MB |
| 4 documents open | ~140 MB |
| 5th document opened (LRU evicts) | ~141 MB (no jump) |
| After rendering 70 pages | ~243 MB |
| After `closePdf` (heap drops; RSS arena retained) | ~243 MB |

Practical planning number: **~15-35 MB per open document**, plus ~80 MB native
canvas/pdf.js baseline, plus page-render arena growth if you render many pages
in one session. Four cached books plus a long render session should stay in the
200-300 MB RSS range on this machine.

## Pitfalls for the host author

1. **`printedOffset` sign.** It is `physical - printed` (20, not -20). Compute
   `printed = pdf - printedOffset`. This is the only place the contract was
   ambiguous; it is documented here and in the module.
2. **Paths with spaces are fine, wrong paths are not.** Pass the plain absolute
   filesystem path to pdf.js (the core does). A missing/relative-wrong path
   produces the confusing pdf.js error
   `Unexpected server response (0) while retrieving PDF`; the core pre-stats
   the file and maps this to `PDF_NOT_FOUND` / `PDF_UNREADABLE`.
3. **Polyfill order matters.** `DOMMatrix`, `Path2D`, and `ImageData` from
   `@napi-rs/canvas` must be installed on `globalThis` **before**
   `pdfjs-dist/legacy/build/pdf.mjs` evaluates. `pdf.js` exports
   `__loadPdfjs()` that does this lazily; do not import the pdf.js legacy build
   yourself before calling core (or install the polyfills first).
4. **Use the legacy build.** Import
   `pdfjs-dist/legacy/build/pdf.mjs`, not `build/pdf.mjs`. The legacy build is
   what works under Node here.
5. **Fake worker, no worker thread.** pdf.js sets `GlobalWorkerOptions.workerSrc`
   to its own `pdf.worker.mjs` and runs the "fake worker" in-process on Node.
   There is no `Worker` thread to terminate yourself; `closePdf()` destroys the
   loading task. Do not set a browser `workerSrc` for this core.
6. **Fonts/CMaps/WASM.** The core points `standardFontDataUrl`, `cMapUrl`
   (packed), and `wasmUrl` at the installed `pdfjs-dist` package, with the
   trailing slash pdf.js requires. This keeps rendering working without network
   access. If you relocate/bundle `pdfjs-dist`, update those paths or rendering
   will fall back/warn or fail on non-embedded fonts and CJK CMaps.
7. **Scale and crop are validated, not clamped.** `scale` outside 1..3 throws;
   crop fractions outside the page throw. Validate in the tool schema too so
   the model gets a useful message.
8. **Search is literal, not regex, and does not unfold hyphenation.** A word
   split as `decom-\nposition` will not match `decomposition`. Whitespace and
   case are normalized only. Search scans every page even after `limit` is hit
   so `pages` is accurate; expect ~0.8 s for a 410-page book.
9. **Page labels come from the PDF, not from visible text.** Some books have
   duplicate/odd roman labels (LADR's PDF page 4 is labelled `ii` by pdf.js).
   Only numeric labels drive `printedOffset`; numeric deltas are taken by mode.
   If a PDF has no page labels, `labels: []` and `printedOffset: null` — do not
   invent an offset from the outline.
10. **Outline resolution is best-effort.** Bad/missing destinations are dropped
    instead of failing the whole `getInfo`; the returned outline can be shorter
    than the raw PDF outline. Depth is preserved for what remains.
11. **PNG is RGB, color type 2.** If the attachment service assumes RGBA, it
    must not; `Buffer` is a complete PNG, dimensions are also returned. White
    background is baked in.
12. **Concurrency is capped at 2 renders.** Queued renders wait; do not add a
    second unbounded render queue in the host. A render holds the document
    active so the LRU cannot destroy it mid-render.
13. **`closePdf` during an in-flight call does not abort that call.** The
    document is destroyed after the call releases it. If the host needs
    cancellation, it must be added above this core.
14. **No global per-request state.** The only module-level state is the
    document cache, the lazy pdf.js promise, and the render semaphore. Page
    text/PNG buffers are per-call. Separate Node worker threads get separate
    caches.
15. **`package.json` `files`/`exports` are owned by the host half.** This
    module deliberately only added `dependencies`; the final package must
    include `lib/core/*.js` in its published file list (and expose it to the
    host code by import path, e.g. `./lib/core/pdf.js`).

## Internal exports (not part of the host contract)

`pdf.js` also exports `__loadPdfjs`, `__acquireDocument`, `__releaseDocument`,
`__ensureMetadata`, `__normalizePdfPage`, and `PDF_LOAD_TIMEOUT_MS`. They exist
so `render.js` can share the cache and avoid re-acquiring per page. Treat names
starting with `__` as private.

## Running the tests

```sh
cd dsh-book-reader
node test/core.test.mjs
```

The test imports both real PDFs from the workspace root, asserts the LADR
contract (410 pages, offset 20, a resolved 169-entry outline, Chapter 1 -> PDF
21 / printed 1, search hit at PDF 293 / printed 273, 750x1272 RGB PNG > 100 KB),
the second PDF's offset, crop/batch rendering, cache eviction, and generated
corrupt/encrypted fixtures. It writes only to a temporary directory and cleans
up after itself.
