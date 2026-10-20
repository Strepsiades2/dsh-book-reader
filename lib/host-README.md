# dsh-book-reader — host half

Model-facing PDF tools, browser-facing JSON routes, and automatic current-page
context for the `dsh-book-reader` plugin. The browser half is `lib/client.js`;
the PDF engine is `lib/core/pdf.js` + `lib/core/render.js`, imported lazily by
this entry.

The host half is plain hand-written ESM. There is no bundler step for
`lib/index.js`.

---

## Model tools

All three tools are registered through `defineTool` from `@deepseek-ai/dsh-tools`.
`pdf_read_pages` is registered only while `ctx.attachments` is mounted, because
it persists PNGs as durable image attachments. Page numbers accepted by tools
are **1-based**.

### `pdf_info({ path })`

Cheap table-of-contents lookup. No images.

| Argument | Type | Required | Meaning |
|---|---|---|---|
| `path` | string | yes | Absolute `.pdf` path, or a path relative to the session working directory. |

Returns:

```jsonc
{
  "path": "/abs/book.pdf",
  "pageCount": 410,
  "printedOffset": 20,          // pdfPage = printedPage + printedOffset
  "pageNumberMode": "printed",  // "printed" when numeric labels/offset exist, else "pdf"
  "outline": [                  // capped at 200 entries
    { "title": "Chapter 5 Eigenvalues and Eigenvectors", "pdf": 152, "printed": 132, "depth": 0 }
  ],
  "labels": [ { "pdf": 21, "printed": 1 } ], // first maxLabels entries; omitted at maxLabels: 0
  "outlineTruncated": true,     // only when the outline was longer than the cap
  "labelsTruncated": true       // only when labels were longer than maxLabels
}
```

`printed` is a number for body pages and may be a roman-numeral string in front
matter. The route's outline is capped by `maxOutlineEntries` (default 500); the
tool caps at 200 regardless.

### `pdf_search({ path, query, ignore_case?, limit? })`

Literal text-layer search. No images. Hits are locations, not evidence:
extracted math is unreliable.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | — | Absolute `.pdf` path, or session-relative. |
| `query` | string | — | Non-empty literal text. |
| `ignore_case` | boolean | `true` | Case-insensitive search. |
| `limit` | integer | `20` | Maximum hits; clamped to `maxSearchResults`. |

Returns:

```jsonc
{
  "path": "/abs/book.pdf",
  "query": "singular value decomposition",
  "pages": 28,                  // pages with at least one hit; may exceed hits.length
  "hits": [
    { "pdf": 290, "printed": 270, "indexOnPage": 799, "snippet": "… 7E Singular Value Decomposition 270 …" }
  ]
}
```

`printed` may be a string (front-matter roman labels). `indexOnPage` is a
UTF-16 offset into the whitespace-normalized page text and is omitted if the
core does not provide it.

### `pdf_read_pages({ path, pages, page_numbers?, scale?, crop?, image_quality?, include_text? })`

The only image-returning tool. Renders each requested page, saves it through
`ctx.attachments.saveImage`, and returns a native `{ type: "image" }` block per
page beside a short text envelope.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | — | Absolute `.pdf` path, or session-relative. |
| `pages` | string \| integer \| array | — | `"132-134"`, `"132,135"`, `132`, `[132,133,134]`, or an array of range strings. Deduplicated and sorted. |
| `page_numbers` | `"printed"` \| `"pdf"` | auto | `"printed"` when `pdf_info` reports numeric labels/offset, else `"pdf"`. |
| `scale` | number | `2.5` | `1`–`3`. `2.5` is about 180 DPI (the skill's default); use `3` with `crop` for dense subscripts. |
| `crop` | string \| number[4] \| object | none | Fractions with a top-left origin: `"x0,y0,x1,y1"`, `[x0,y0,x1,y1]`, or `{x,y,w,h}`. Normalized to the core's `{x,y,w,h}`. |
| `image_quality` | `"cheap"` \| `"standard"` | `"standard"` | `"cheap"` renders at 1.5× (about 350 tokens/page, prose only); `"standard"` uses `defaultScale` (about 900 tokens/page). An explicit `scale` wins. |
| `include_text` | boolean | `true` | Include up to `maxTextCharsPerPage` characters of extracted text per page. |

Hard cap: `maxPagesPerCall` (default **4**, maximum configurable **8**). Exceeding
it is an error (`PDF_READER_TOO_MANY_PAGES`); pages are never silently dropped.
The call also refuses before rendering when the routed model does not declare
image input (`PDF_READER_NO_IMAGE_INPUT`).

Returns:

```jsonc
{
  "path": "/abs/book.pdf",
  "book": "Linear Algebra Done Right",
  "pageNumbers": "printed",
  "printedOffset": 20,
  "textIncluded": true,
  "pages": [
    {
      "pdf": 152,
      "printed": 132,
      "image": {
        "attachmentId": "…",
        "mediaType": "image/png",
        "bytes": 713136,
        "width": 938,
        "height": 1590,
        "name": "Linear_Algebra_Done_Right-p152.png"
      },
      "text": "Chapter 5 Eigenvalues and Eigenvectors …",
      "textTruncated": false,
      "textUnavailable": false
    }
  ]
}
```

`render()` produces: one header text block, then per page a `<page pdf="…"
printed="…">…</page>` text block followed by the image block. This mirrors
`read_image`'s envelope-plus-image shape. Text extraction failure never fails
the call: the image is still returned with `textUnavailable: true`.

In `page_numbers: "pdf"` mode, `printed` comes from the PDF's page labels when
available, so it can be a roman-numeral string for front matter; in `printed`
mode it is the integer body-page number.

---

## HTTP routes

All routes are served from one prefix registration:
`/dsh-pdf-reader` (`kind: "prefix"`). Responses are JSON only, carry
`cache-control: no-store` and `x-content-type-options: nosniff`, and **never**
carry an `Access-Control-Allow-Origin` header.

Every route that names a file applies the same hardening as `dsh-pdf-search`:

1. `Host` must be loopback (`127.0.0.1`, `localhost`, `::1`, any port).
2. `path` must be an **absolute** path.
3. The suffix must be `.pdf` (case-insensitive).
4. The target must be a regular file.
5. The target must be at most `maxFileBytes` (default 256 MiB).

Failure bodies are `{ "ok": false, "error": "<token>" }` with status 400/403/404/
405/413/415/500 as appropriate. Tokens used by this plugin: `invalid-path`,
`missing`, `not-a-file`, `file-too-large`, `forbidden-host`,
`method-not-allowed`, `missing-query`, `query-too-long`, `invalid-limit`,
`unsupported-media-type`, `body-too-large`, `invalid-json`, `invalid-page`,
`invalid-zoom-mode`, `invalid-zoom-scale`, `invalid-session-id`,
`invalid-printed-page`, `info-failed`, `search-failed`, `route-failed`,
`storage-unavailable`, `not-found`.

Tool failures preserve the core's coded error names where the core raises
them: `PDF_NOT_FOUND`, `PDF_ENCRYPTED`, `PDF_CORRUPT`, `PDF_NOT_READABLE`,
`PDF_UNREADABLE`, `PDF_LOAD_TIMEOUT`, `PDF_PAGE_OUT_OF_RANGE` (from deep core
calls). The host adds `PDF_NOT_FILE`, `PDF_READER_INVALID_PATH`,
`PDF_READER_INVALID_PAGE`, `PDF_READER_TOO_MANY_PAGES`,
`PDF_READER_INVALID_PAGE_MODE`, `PDF_READER_NO_PRINTED_PAGES`,
`PDF_READER_INVALID_CROP`, `PDF_READER_INVALID_SCALE`,
`PDF_READER_FILE_TOO_LARGE`, `PDF_READER_NO_IMAGE_ROUTE`,
`PDF_READER_NO_IMAGE_INPUT`, `PDF_READER_NO_ATTACHMENTS`,
`PDF_READER_RENDER_FAILED`, `PDF_READER_ATTACHMENT_FAILED`, and
`PDF_READER_IMAGE_TOO_LARGE`.

### `GET /dsh-pdf-reader/info?path=<absolute .pdf>`

```jsonc
{
  "ok": true,
  "path": "/abs/book.pdf",
  "pageCount": 410,
  "printedOffset": 20,
  "outline": [{ "title": "…", "pdf": 152, "printed": 132, "depth": 0 }],
  "labels": [{ "pdf": 21, "printed": 1 }],
  "outlineTruncated": true
}
```

`labels` is omitted when the core has none. The outline is capped at
`maxOutlineEntries` (default 500).

### `GET /dsh-pdf-reader/search?path=<abs>&q=<text>&ignoreCase=1&limit=100`

```jsonc
{
  "ok": true,
  "hits": [{ "pdf": 290, "printed": 270, "snippet": "…" }]
}
```

`ignoreCase` is true only for `1` or `true`; the default is case-sensitive.
`limit` defaults to `maxSearchResults` (100) and is clamped to it; non-positive
or non-integer values are rejected. A missing/empty `q` is `400 missing-query`.
The response intentionally omits the core's `pages` count (the tool exposes it).

### `POST /dsh-pdf-reader/current`

Request body (`Content-Type: application/json` required; default cap 64 KiB):

```jsonc
{ "path": "/abs/book.pdf", "pdfPage": 152, "printedPage": 132, "sessionId": "session-…" }
```

Response: `{ "ok": true }`.

- `pdfPage` must be a positive integer (numeric strings are accepted for
  convenience).
- `printedPage` is optional and may be a number or a short label such as `"xii"`.
- `sessionId` is optional. **When present, the position is stored for that
  session and is eligible for auto-share. When absent, only a path-keyed
  position is stored, which the `GET` form can read but auto-share will not
  use.** The browser half sends `sessionId` from its Session-scoped slot.

### `GET /dsh-pdf-reader/current?sessionId=<id>`

Also accepts `?path=<abs>` as a fallback when no `sessionId` is supplied.

```jsonc
{
  "ok": true,
  "path": "/abs/book.pdf",
  "pdfPage": 152,
  "printedPage": 132,
  "section": { "title": "5B The Minimal Polynomial", "pdf": 150, "printed": 130, "depth": 1 },
  "sectionTrail": ["Chapter 5 Eigenvalues and Eigenvectors", "5B The Minimal Polynomial"]
}
```

or `{ "ok": true, "current": null }` when no position is known. `printedPage`
may be `null` if the PDF has no printed-page information and the browser did not
supply a label, and may be a roman-numeral string in front matter. Section fields
are omitted when the outline cannot be loaded.

### `GET /dsh-pdf-reader/view?path=<absolute .pdf>`

Reads the remembered page/zoom for one book:

```jsonc
{
  "ok": true,
  "view": {
    "path": "/abs/book.pdf",
    "pdfPage": 152,
    "zoomMode": "fixed",       // or "fit-width"
    "zoomScale": 1.5,          // resolved scale, 0.25..4
    "updatedAt": 1760000000000
  }
}
```

`view` is `null` when nothing is remembered, when `rememberView` is `false`,
when the storage service is unavailable, or when the stored record is malformed.
The route deliberately does **not** stat the PDF: the browser may ask while the
preview is still opening, and a missing book's stale record is harmless.

### `POST /dsh-pdf-reader/view`

Request body (`Content-Type: application/json` required; default cap 64 KiB):

```jsonc
{ "path": "/abs/book.pdf", "pdfPage": 152, "zoomMode": "fixed", "zoomScale": 1.5 }
```

Response `{ "ok": true }`; the Host stamps `updatedAt` itself and never trusts a
client timestamp. Validation errors: `400 invalid-path` (relative, non-`.pdf`,
empty, or longer than 4096 characters), `invalid-page` (integer 1–100000),
`invalid-zoom-mode` (`fit-width` or `fixed`), `invalid-zoom-scale` (finite
0.25–4). `rememberView: false` keeps validation but makes the write a no-op;
`503 storage-unavailable` means the write could not be made durable, so the
browser retries on its next trigger.

### Where the view state lives

`apply()` opens the `book_reader_views` storage domain (version 1, layout
`single`, table `views`) through `ctx.storageDomain` when `rememberView` is on.
The JSON backend persists it under the DSH data directory, so it survives
restarts. Each record is keyed by `sha256(absolute path)`; reads verify the
record's `path` before returning it, and the table keeps at most 500 books
(oldest `updatedAt` pruned after a write). The storage-domain and zod modules
are imported dynamically: when the service or packages are unavailable the
feature disables itself, warns once, and the plugin, tools, and routes keep
working (`GET` answers `view: null`, `POST` answers `503`).

---

## Auto-share: how a reading position reaches the conversation

`apply()` registers one **prepended** `agent/pre-step` waterfall listener (the
same mechanism as `dsh-time-context`). It first calls `next()`, never modifies a
rejected step, and appends at most one user-role message **per turn**.

A message is injected only when **all** of these hold:

1. `enabled` and `autoShare` are true.
2. The downstream decision is not `reject` and the step signal is not aborted.
3. A position exists for `agent.session.id` — the exact session in this turn.
   There is no "most recently reported path" fallback, so a position from
   another session is never injected.
4. The position's `(path, pdfPage)` differs from the last injected position.
5. This turn has not already received a hint (one hint per turn).
6. If `autoShareMinIntervalMs > 0`, at least that many ms have elapsed since
   the last hint (`0`, the default, imposes no time throttle).
7. If `autoSharePageDelta > 1`, the page changed by at least that many pages.
8. If `autoShareMaxAgeMs > 0`, the browser-reported position is not older than
   that age.

The message text is short and source-attributed:

```text
[dsh-pdf-reader] The user is reading "Linear Algebra Done Right-Springer (2024)" at printed page 132 (PDF 152) — Chapter 5 Eigenvalues and Eigenvectors.
If they say "this page"/"当前页", call pdf_read_pages with path:"/abs/book.pdf" and pages:"132".
```

The durable message source is:

```js
{ kind: 'pdf-reader', form: 'snapshot', sections: [{ name: 'pdf-reader', text }] }
```

The section trail comes from the outline (`sectionTrailForPage`); the lookup uses
the shared `getInfo` cache and degrades to a page-only message if the outline
cannot be loaded. The printed page is the browser-reported label, or
`pdfPage - printedOffset` when the PDF exposes numeric labels.

### Turning it off

- `autoShare: false` — keep all tools and routes, stop injecting context.
- `enabled: false` — mount nothing: no tools, no routes, no listener.
- `autoShareSection: false` — skip the `getInfo`/outline lookup used by the
  listener. The message then names the printed page only if the browser sent
  `printedPage`; otherwise it falls back to the PDF page.
- `autoShareMaxAgeMs`, `autoShareMinIntervalMs`, and `autoSharePageDelta` tune
  the hint rule.

---

## Configuration

All keys are optional. The same defaults are applied by the loader schema and by
`normalizeConfig()` inside `apply()`.

| Key | Default | Range | Meaning |
|---|---|---|---|
| `enabled` | `true` | boolean | Master switch for tools, routes, and listener. |
| `rememberView` | `true` | boolean | Remember the last page/zoom per book in the `book_reader_views` domain. |
| `autoShare` | `true` | boolean | Inject the current reading page, once per turn. |
| `autoShareSection` | `true` | boolean | Resolve the outline section for the injected message. |
| `autoShareMinIntervalMs` | `0` | 0–86400000 | Optional minimum ms between hints; `0` = no time throttle. |
| `autoSharePageDelta` | `1` | 1–1000 | Minimum absolute page change. |
| `autoShareMaxAgeMs` | `0` | 0–31536000000 | Ignore positions older than this; `0` = no limit. |
| `maxPagesPerCall` | `4` | 1–8 | Hard image cap for `pdf_read_pages`. |
| `defaultScale` | `2.5` | 1–3 | Default render scale (~180 DPI at 2.5). |
| `maxTextCharsPerPage` | `1200` | 0–100000 | Text kept per page; `0` disables text. |
| `maxSearchResults` | `100` | 1–500 | Cap for tool and route search limits. |
| `maxOutlineEntries` | `500` | 1–5000 | Route outline cap (`pdf_info` also caps at 200). |
| `maxLabels` | `80` | 0–1000 | Labels included by `pdf_info`. |
| `maxFileBytes` | `268435456` | ≥1 | Largest PDF the plugin will touch. |
| `maxRouteBodyBytes` | `65536` | 1024–4194304 | Largest POST body. |
| `infoCacheSize` | `8` | 1–64 | `getInfo` results cached by path+mtime+size. |

YAML example:

```yaml
- id: pdf-reader
  name: 'dsh-book-reader'
  config:
    autoShare: false
    maxPagesPerCall: 3
```

---

## Known limitations

- **The browser must report `sessionId`.** Auto-share only reads positions
  keyed by the exact session id; a path-only `POST /current` is visible through
  `GET /current?path=…` and to nothing else. This is deliberate: no stale
  position from another session is ever injected.
- **Injection state is process-local.** It is not written to the session log or
  a projection. After a process restart the first eligible turn may inject the
  current page once again; the turn/page guards then resume from memory.
- **Auto-share sends at most one hint per turn.** A second page change inside
  the same turn waits for the next user message; in between, the model can ask
  the user or read the page the user references explicitly.
- **The route is unauthenticated beyond the loopback Host check.** Any local
  process can ask it to read any local `.pdf`; the absence of a CORS header
  stops a web page from reading the response, but it is not a sandbox. This is
  the same tradeoff as `dsh-pdf-search`.
- **PDF paths are arbitrary local paths.** The tools and routes do not consult
  `ctx.fs` or the workspace sandbox; they stat and parse the path directly.
- **Relative tool paths use the session's original `header.cwd`.** A later
  `working_directory` change is not consulted; absolute paths are preferred and
  are what the browser half reports.
- **Front-matter roman labels cannot be passed to `pdf_read_pages`.** The
  auto-share hint falls back to the physical PDF page (`page_numbers: "pdf"`)
  while still naming the printed label in prose.
- **The image path needs an image-capable route and an attachment store.** The
  tool is not registered without `ctx.attachments`, and each call refuses before
  rendering when the routed model does not declare image input.
- **Remembered view state needs the storage domain.** Without `ctx.storageDomain`
  (or when its backend rejects the open), the browser half's GETs answer
  `view: null` and its POSTs answer `503`; page/zoom memory is simply off. The
  plugin warns once and everything else keeps working.
- **Remembered view state is best effort.** Restoring is the browser half's job
  and depends on the official preview's private zoom frame/gesture; a renderer
  change can reduce it to page-only restore. Writes are debounced, so the last
  ~500 ms of reading before the preview closes can be lost.
- **One record per book path.** The key is the absolute path, so moving a file
  (or replacing it in place) keeps the old record. Two open tabs of one book
  share it and the last write wins.

---

## Wiring and verification

`apply(ctx)` requires the `tools`, `webServer`, and `agents` services. The image
tool is registered inside `ctx.inject(['attachments'], …)`. Remembered page/zoom
opens the `book_reader_views` domain inside `ctx.inject(['storageDomain'], …)`
when `rememberView` is on; both injections are optional and their absence only
disables the corresponding feature. The core is loaded lazily from
`./core/pdf.js` and `./core/render.js`; a missing core produces a clear
`PDF core is unavailable` / `PDF renderer is unavailable` tool error and a 500
on the routes instead of a silent fallback.

Plain-`node` tests (no harness, no core required):

```sh
node test/host.test.mjs
# all 49 host tests passed
```

The tests import the real `lib/index.js`, stubbing the host-provided bare
specifiers (schemastery, tools, llm, storage-domain, zod), and cover page-range
parsing, printed/PDF resolution, section trails, auto-share text and throttle
decisions, config validation, route hardening, route responses (including the
`/view` round trip and validation), tool registration, tool registration counts
and the image-bearing read tool.

A separate real-core integration run against
`Linear Algebra Done Right-Springer (2024).pdf` verified `getInfo` (410 pages,
offset +20, 169 outline entries), search, printed→PDF translation (printed
132/133 → PDF 152/153), real 938×1590 PNG rendering at the 2.5× default through a fake attachment
store, `POST/GET /current`, `pdf_current_page`, and one injected pre-step
message. That run used Electron's Node so the installed `defineTool` and
Schemastery validated the real schemas, but it did **not** run the DSH agent
loop itself.
