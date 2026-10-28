# dsh-book-reader — browser half

Decorates DSH's **official right-sidebar PDF preview**. It does not replace the
renderer: zoom, fit width, text selection, reload, auto-refresh, and Office→PDF
all keep working. Removing the plugin row removes these controls and nothing
else.

The bundle is `lib/client.js`, in the same `window.__ModuleLoader__.load({ id,
factory })` shape as `dsh-pdf-search/lib/client.js`. React is the only external.

## What the header adds

For a `.pdf` preview only (matched on the `absolutePath` owner prop):

| Control | Behavior |
|---|---|
| `‹` / `›` | Previous / next **physical** PDF page (consecutive pages, regardless of printed labels). |
| `[132] / 410` | Current-page readout that follows scrolling. The box is also the jump box: type a page and press Enter. Shows the printed page when an offset is known, otherwise the physical page. |
| `⌕` | Opens the find bar. |
| `AI` + dot | Auto-follow / AI-context reporting toggle. Dot: green = host acknowledged, amber = sending, red = host route failed, faded = off. |

The find bar is a basic in-page search: type a query, `Enter` / `Shift+Enter`
(or the `‹` / `›` buttons) jump between occurrences with an `n / total` counter.
Matches are highlighted on the page's text layer (active one stronger); there is
no result list, no snippet, and no composer insertion.

## Hover explanations

Every control explains itself on hover and on keyboard focus: a small tooltip
with a title plus one line of guidance (`上一页 / Previous page`,
`页码 / Page number`, `AI 上下文 / AI context`, …). The text follows the active
DSH UI language, read through the injected `locale` service; the follow control
also appends its live state (off / reporting / acknowledged / route failed).
The tooltip appears after a short delay, hides on leave or blur, and is
`pointer-events: none` so it never intercepts a click.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Cmd/Ctrl + F` (with or without `Shift`) | Open the find bar for the preview the pointer last claimed; focuses and selects the query. The plain chord is intercepted before the browser's own find. |
| `Esc` | Close the find bar (or cancel the page box / panel input). |
| `Enter` in the page box | Jump. Plain numbers are printed pages when the offset is known; prefix `p` for physical. |
| `Enter` / `Shift+Enter` in the find bar | Next / previous occurrence (wraps). |

With several PDF previews open, the chord is answered by the preview the user
last pointed at or focused. Buttons in every preview still work independently.

## Search and highlights

- Query changes are debounced (220 ms) and call
  `GET /dsh-pdf-reader/search` with `ignoreCase=1&limit=100`; stale requests are
  aborted. Only the `pdf` page number of each hit is used — snippets are ignored.
- All matches are highlighted with the CSS Custom Highlight API
  (`dsh-book-reader-search`, translucent yellow) and the current occurrence with
  a second highlight (`dsh-book-reader-search-active`, orange); an idempotent
  `<style>` tag supplies the `::highlight(...)` rules. Without the API, the
  overlapping spans get `.dsh-book-reader-search-hit` /
  `-active-hit` classes instead.
- Ranges are built from the rendered page's `[data-pdf-text]` text nodes: a
  TreeWalker concatenates them, a length-preserving case fold finds literal
  matches, and global offsets map back to nodes for `Range`s. The active
  occurrence is the hit's ordinal among earlier hits on the same page; if the
  client finds fewer matches than the Host, everything is still highlighted and
  the first one becomes active.
- Page text layers render lazily and rebuild on zoom, so highlights retry for up
  to 3 s after a jump and a debounced MutationObserver on the preview body
  rebuilds them when pages render. All highlights, timers, and observers are
  cleared on close, query change, path change, and unmount.

## Page numbering

`/dsh-pdf-reader/info` reports `printedOffset` such that

```
physical pdf page = printed page + printedOffset
```

For LADR, `printedOffset = 20`, so printed 132 = PDF 152. The readout uses
printed 132; the total (`/ 410`) remains the physical page count reported by the
Host. Front matter has no numeric printed label (and pages at or below the
offset yield no printed number), so the readout falls back to the physical page
there.

Jump-box input:

- `132` → printed 132 → PDF 152, when an offset is known;
- `132` → PDF 132, when no offset is known;
- `p152`, `p.152`, `PDF 152`, `#152` → always PDF 152;
- values outside `1..pageCount` are rejected with a quiet message rather than
  clamped, so a mistyped printed page cannot silently land on page 410.

## Remembered page and zoom

The official preview keeps neither the scroll position nor the zoom across tabs
or restarts: its zoom preference lives in a per-tab in-memory store, and
byte-view scroll is explicitly not restored. The plugin owns this state:

- On mount the contribution `GET`s `/dsh-pdf-reader/view?path=…` in parallel
  with rendering, waits (up to about 8 s) for the preview pane and the saved
  page element, and **scrolls that page into view immediately** with
  `scrollPageIntoView` — before any zoom replay — so the cover does not flash
  while a fixed zoom is being restored. The scroll is re-applied once after
  300 ms so lazily rendered pages cannot leave the view offset.
- Fixed zoom is restored afterwards through the preview's own gesture path: its
  native `wheel` listener on `[data-document-zoom-scrollport]` reacts to
  `ctrlKey` with `scale * exp(-deltaY * 0.01)` (deltaY clamped to ±40) and
  commits a fixed preference 120 ms after the last event. The plugin dispatches
  synthetic `WheelEvent`s with `deltaY = -100·ln(target/current)` until the
  frame's inline `--document-zoom` is within 2%, waits for that settle commit,
  then scrolls the saved page again because the zoom reflowed every page.
  `fit-width` is the preview's default mode and needs no restoration.
- Saving is gated until the page is placed (and, for a fixed zoom, until the
  zoom settles) so opening a book cannot overwrite its saved page with page 1.
  Page samples and frame attribute changes (`style`,
  `data-document-zoom-mode`) feed one 500 ms debounce that `POST`s
  `{ path, pdfPage, zoomMode, zoomScale }`; the Host stamps `updatedAt`.
- Everything degrades silently when a marker, the route, or the storage service
  is missing. The last ~500 ms before unmount can be lost because the effect
  deliberately has no flush-on-unmount.

## Auto-follow / AI context

After the readout first resolves, every page change is reported once, trailing
400 ms after scrolling stops:

```http
POST /dsh-pdf-reader/current
Content-Type: application/json

{"path":"/abs/book.pdf","pdfPage":152,"printedPage":132,"sessionId":"…"}
```

`printedPage` and `sessionId` are omitted when unavailable. Requests are
aborted when superseded, when the toggle is switched off, on path change, and on
unmount. The toggle is shared by all mounted previews on the page: turning it
off in one PDF stops reporting everywhere. It is not persisted across reloads.
Initial page 1 is reported too, so "what page am I on" works before the user
scrolls.

## Host routes and tolerance

- `GET /dsh-pdf-reader/info?path=<abs>` — fetched once per PDF, cached for up to
  16 paths; falls back to the DOM's last `[data-pdf-page]` when unavailable.
- `GET /dsh-pdf-reader/search?path=<abs>&q=<str>&ignoreCase=1&limit=100` — 220 ms
  debounce, stale requests aborted; the find bar uses only each hit's `pdf` page.
- `POST /dsh-pdf-reader/current` — 400 ms debounce, one in-flight POST.

All fetches are same-origin and relative. A missing/not-yet-mounted Host route
is quiet: the readout falls back to physical numbering, search shows
`Search unavailable (HTTP 404).`, and the AI dot turns red. Nothing throws into
the preview.

## DOM assumptions (and evidence)

The extension surface is stable; the DOM markers are private to the current DSH
build and could be renamed by an upgrade.

| Assumption | Evidence |
|---|---|
| The preview declares `sidebar.right.tab.document.actions` as a `list`, `scope: "session"`, whose standard props include `sessionId` and `inputActions`. | `dsh-cordis-client-runner/lib/client.js` slot catalog, `sidebar.right.tab.document.actions` entry (`standardProps` includes `useInput`, `inputActions`, `sessionId`). |
| The owner passes `absolutePath` to that slot. | `reference/dsh-client-ui-sidebar-documentpreview-README.md` §What it registers: “both with `absolutePath` as the owner prop”; the preview's built `client.js` calls `renderSlot("sidebar.right.tab.document.actions", fileOwner)` with `fileOwner = { absolutePath }`. |
| The preview body is marked `data-textpreview-body`, and the real scroll container is the inner `data-document-zoom-scrollport`. | README §How it reads (“each renderer … may own an inner scrollport”); `dsh-pdf-search/src/client/action.ts:162-192` resolves exactly these markers. |
| Pages are `[data-pdf-page]` wrappers; all page wrappers exist up front and off-screen content is a 3:4 placeholder. | README: “pages form a vertical sequence … pages render lazily near the viewport; an unrendered page holds its place as a quiet 3:4 placeholder block.” The built PDF body maps every page number to a `PdfPage` wrapper carrying `data-pdf-page`. |
| Jumping must write the **inner** scrollport, then the renderer's `IntersectionObserver` draws the lazy page. | `dsh-pdf-search/src/client/action.ts:119-127` (scrollPageIntoView) and `test/scroll-navigation.test.mjs:130-140` (asserts the scrollport, not the body, moves). |
| The rendered page's selectable text layer lives under `[data-pdf-text]` and exists only for pages rendered so far; zooming rebuilds it. | The preview's `client.pdf.js` `pdfTextRenderer` appends `TextLayerBuilder` output to the `[data-pdf-text]` container, and `PdfPage` creates it only while rendering. |

## Performance on a 410-page book

- Scroll handling is one `requestAnimationFrame` callback and a **binary search**
  over cached page tops — O(log n), no DOM reads per scroll event.
- Geometry is measured O(n) only when layout changes (mount, resize/zoom,
  visibility change), coalesced by a 120 ms debounce, and **never while the
  scrollport is scrolling**: the measurement is deferred until ~260 ms after the
  last scroll event. It is also skipped while the remembered page/zoom restore
  is in flight, because that is exactly when the first restored page paints.
  Measuring 410 wrappers during lazy page rendering forced a full preview layout
  against PDF.js and could delay a high-DPR page's canvas paint by seconds; page
  wrappers are cached between passes. A structural observer watches for a
  replaced preview body/scrollport, not for every lazy canvas.
- Search hits are capped at 100 by the Host; highlight rebuilding is debounced
  (60 ms) and only touches pages that have hits.

## Known limits

- **Official PDF preview only.** `.docx`/`.pptx` (even when converted to PDF),
  images, Markdown, and code previews have non-`.pdf` `absolutePath`s and show no
  controls.
- **Private DOM markers.** A DSH upgrade that renames `data-pdf-page`,
  `data-textpreview-body`, or `data-document-zoom-scrollport` disables the
  controls without breaking the preview; the slot entry simply renders inert
  controls.
- **Printed labels are numeric only.** Roman/letter front-matter labels (`i`,
  `xvii`) are not parsed; those pages show physical numbers, and jumping to them
  must use `pN`.
- **Offset trust.** `printedOffset` is assumed to mean
  `physical = printed + offset` (the `pdfkit info` convention). A Host that
  returns the opposite convention would invert the readout.
- **Scanned PDFs.** Search returns no matches / a “no text layer” message, so
  there is nothing to highlight; the readout and jump still work because they use
  page wrappers, not extractable text.
- **Search is case-insensitive substring matching** (`ignoreCase=1`), capped at
  100 hits; no regex, whole-word mode, or hyphenation unfolding.
- **Follow preference is page-lifetime and global** across open PDF previews; it
  is not stored.
- **The info cache is keyed by path**, so replacing a PDF at the same path while
  the page is open can leave a stale page count/offset until reload.
- **The find bar is fixed at the top-right.** If another PDF add-on binds
  `Cmd/Ctrl+F` too, the last registered document capture listener runs first;
  uninstall the other add-on if the shortcut feels contested.
- **Live GUI verification is still required** (profile install is the Lead's
  step): the slot prop shape, shortcut arbitration, and real PDF.js lazy
  rendering plus highlight painting are covered only by the headless tests here.

## Test

```sh
node dsh-book-reader/test/client.test.mjs
```

It reuses the `jsdom`/React install under `dsh-pdf-search/node_modules` (the
same packages the earlier prototype test used), so run it from a workspace where
that sibling still exists.

The test loads the real bundle through a fake `window.__ModuleLoader__`, checks
the slot registration, page numbering/parsing, debounce/throttle timing, DOM
marker resolution, inner-scrollport jumping, a live jsdom mount (info → readout →
report → toggle → jump → find bar navigation → shortcut → two-preview
election → cleanup), in-page search highlights (fake CSS Highlight API and span
fallback, active occurrence, text-layer re-render), saved-page/zoom restore
(held GET, wheel dispatch, gated persistence), and quiet behavior for missing
Host routes and non-PDF paths.

## Verification status

- `node test/client.test.mjs` passes, including the saved-page/zoom restore,
  gating and persistence tests plus the in-page search highlight tests.
- The restore path uses private renderer markers and behaviour observed in DSH
  0.2.1-rc.2 (`[data-document-zoom-frame]`, the inline `--document-zoom`, the
  `ctrl+wheel` listener), and highlights use the rendered `[data-pdf-text]` text
  layer plus the Chromium CSS Custom Highlight API. Headless jsdom tests simulate
  both; a real GUI check of restored page/zoom and painted highlights is still
  required.
- The live app accepted the client's `POST /current` and `POST /view` bodies in
  manual runs. Mounting the contribution in the real GUI (header layout at the
  actual sidebar width, standard props, composer insertion, real lazy PDF
  rendering) remains a manual smoke test.
