# dsh-pdf-reader — browser half

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
| `⌕` | Opens the search panel. |
| `↗` | Inserts `[PDF p.132]` at the composer caret. |
| `AI` + dot | Auto-follow / AI-context reporting toggle. Dot: green = host acknowledged, amber = sending, red = host route failed, faded = off. |

The panel lists `p.132 — snippet` results. Clicking a result jumps to that page;
each result also has a **`→ AI`** button that inserts `PDF p.132: <snippet>` at
the composer caret. The snippet is whitespace-collapsed and bounded to ~160
characters.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Cmd/Ctrl + Shift + F` | Open the search panel for the preview the pointer last claimed; focuses and selects the query. |
| `Esc` | Close the panel (or cancel the page box / panel input). |
| `Enter` in the page box | Jump. Plain numbers are printed pages when the offset is known; prefix `p` for physical. |
| `Enter` in the search box | Jump to the first result. |
| `Cmd/Ctrl + F` | **Deliberately not intercepted.** `dsh-pdf-search` and the browser keep it. |

With several PDF previews open, the chord is answered by the preview the user
last pointed at or focused. Buttons in every preview still work independently.

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

## Composer insertions

The contribution is a **Session-scoped** slot entry, so it receives the standard
`sessionId` and `inputActions` props. Insertion is:

```js
const span = inputActions.captureInsertion()
inputActions.insertText(text, span)
```

This inserts one undoable plain-text edit at the draft selection only while the
captured revision is current. The plugin never calls `setDraft`, so the user's
draft is preserved. If the composer rejects the edit (busy/submitting) or the
standard props are missing, the reference is copied to the clipboard instead and
the header flashes `(copied)` / `Composer busy`.

Search-result payloads use the printed page when the Host supplies one:
`PDF p.132: singular value decomposition`. The share button uses the shorter
`[PDF p.132]`.

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
  debounce, stale requests aborted.
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
| Composer insertion is `captureInsertion()` + `insertText(text, span)`, one undoable edit while the revision is current. | `dsh-client-ui-conversation/README.md:165`; the built input shell maps those to `caretSpan()` + `insertAsyncText()`. |

## Performance on a 410-page book

- Scroll handling is one `requestAnimationFrame` callback and a **binary search**
  over cached page tops — O(log n), no DOM reads per scroll event.
- Geometry is measured O(n) only when layout changes (mount, resize/zoom,
  visibility change, page render that changes the page-section height), coalesced
  by a 120 ms debounce. A structural observer watches for a replaced preview
  body/scrollport, not for every lazy canvas.
- Search results are capped at 100, so the panel never renders 410 rows.

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
- **Scanned PDFs.** Search returns no matches / a “no text layer” message;
  readout, jump, share, and AI insertion still work because they use page
  wrappers, not extractable text.
- **Search is case-insensitive substring matching** (`ignoreCase=1`), limited to
  100 hits; no regex, whole-word, or match navigation inside a page.
- **Follow preference is page-lifetime and global** across open PDF previews; it
  is not stored.
- **The info cache is keyed by path**, so replacing a PDF at the same path while
  the page is open can leave a stale page count/offset until reload.
- **Both search panels are fixed at the top-right.** If this panel and
  `dsh-pdf-search`'s find bar are open together they overlap visually; their
  shortcuts and DOM are otherwise independent. The shortcuts are deliberately
  different (`Cmd/Ctrl+Shift+F` here, `Cmd/Ctrl+F` there).
- **Composer integration requires the session composer.** Without it (or while it
  refuses edits), the fallback is the clipboard, not a draft rewrite.
- **Live GUI verification is still required** (profile install is the Lead's
  step): the slot prop shape, shortcut arbitration against `dsh-pdf-search`, and
  real PDF.js lazy rendering are covered only by the headless tests here.

## Test

```sh
node dsh-pdf-reader/test/client.test.mjs
```

It reuses the `jsdom`/React install under `dsh-pdf-search/node_modules` (the
same packages the earlier prototype test used), so run it from a workspace where
that sibling still exists.

The test loads the real bundle through a fake `window.__ModuleLoader__`, checks
the slot registration, page numbering/parsing, composer payload and
`captureInsertion`/`insertText` use, debounce/throttle timing, DOM marker
resolution, inner-scrollport jumping, a live jsdom mount (info → readout →
report → toggle → jump → share → search → `→ AI` → shortcut → two-preview
election → cleanup), and quiet behavior for missing Host routes and non-PDF
paths.

## Verification status (this checkout)

- `node dsh-pdf-reader/test/client.test.mjs` passes.
- The live app accepted the client's exact `POST /dsh-pdf-reader/current` body
  (`{"path":…,"pdfPage":152,"printedPage":132,"sessionId":…}`) with
  `{"ok":true}`, and `GET /current` echoed `pdfPage:152, printedPage:132`.
- `GET /info` and `GET /search` currently fail in this checkout with a
  **Host-side** `pdfjs-dist` version mismatch
  (`API version "6.4.299" does not match the Worker version "6.3.289"`), so the
  printed-numbering readout and search could only be exercised against fixtures,
  not end-to-end. The client's missing-route/failure path is tested and degrades
  quietly.
- Mounting the slot contribution in the real GUI (header layout at the actual
  sidebar width, standard props, composer insertion, real lazy PDF rendering)
  was not verified here; profile install is the Lead's step.
