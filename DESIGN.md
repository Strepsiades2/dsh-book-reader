# dsh-pdf-reader — research, feasibility, and prototype

Status: research complete; AI-side half built and verified; client-side header
prototype built and headlessly tested, **not installed into the live profile**.

Environment inspected:

- DSH desktop app: `/Applications/DeepSeek Harness.app`
- DSH version: `0.2.1-rc.2` (`runtime/cli/bin/dsh --version`)
- Installed client packages in the app bundle:
  `@deepseek-ai/dsh-client-ui-sidebar-documentpreview@0.2.1-rc.2` and
  `@deepseek-ai/dsh-client-ui-sidebar-right@0.2.1-rc.2`
- User profile: `~/.dsh/profiles/desktop` (read-only observation)
- Workspace: `/Users/zyl/my_projects/learn /math`

The app bundle is an asar archive, not a directory. I read it with a small
header parser (`16 + headerSize + 2` is the data base offset, verified by
`JSON.parse` of an extracted `package.json`). The two package READMEs that
document the extension API are preserved under `dsh-pdf-reader/reference/` so
the evidence survives scratch cleanup.

---

## 1. What already exists in DSH

### 1.1 A native, right-side PDF preview already ships

`@deepseek-ai/dsh-client-ui-sidebar-documentpreview` renders PDFs in the native
right sidebar. Evidence:

- `dsh-pdf-reader/reference/dsh-client-ui-sidebar-documentpreview-README.md:57`
  — PDF is a “complete bytes” renderer read through
  `remote.workspaceFiles.readBytes(sessionId, path, {}, signal)`.
- Same file `:64` — PDF/image zoom control: Fit width, 25–200%, 25% steps,
  25–400% range, device-pixel-ratio-aware redraw.
- Same file `:66` — PDF.js and its worker live in a lazy `client.pdf.js` chunk;
  pages are a vertical sequence rendered lazily near the viewport, with a
  selectable PDF.js text layer; off-screen pages are 3:4 placeholders.
- Same file `:96–106` — Word/PowerPoint convert locally to PDF and reuse the same
  viewer.
- Same file `:126` — navigation accepts only `{ line }` (text source lines);
  “Byte-mode renderers do not consume source-line navigation”, i.e. no page
  parameter.
- Same file `:131` — model experience: “None, as the preview is a browser-only
  viewer that registers no tool, prompt section, or session event.”
- Same file `:140` — known limitation: “The viewers provide no file editing or
  shared search interface.”
- Same file `:144` — byte-view scroll state is not restored across remounts.

So **requested feature 1 (right-side PDF preview) is already done by the host**.
Building another preview would duplicate a mature PDF.js integration.

### 1.2 DSH has a real client plugin / extension API

The extension surface is the slot + tab-type system, not a separate “webview”
API. Three layers matter:

**a) Right-sidebar tab types and navigation.**
`dsh-pdf-reader/reference/dsh-client-ui-sidebar-right-README.md:83`:

> `ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?,
> title, guide?, keepMounted? })`

`:84` — the body is a keyed `sidebar.right.pane.tab` slot registration.
`:93` — `ctx.sidebarRight.openResource(address, options?)` /
`openTab(kind, options?)` are the navigation controller; `params` reach the body
as `navigation.params`.
`:48` — presentation via `ctx.layout.openRightbar(track, fullscreen)` /
`closeRightbar()`.

**b) Document-preview header slots.** The preview is extensible exactly where we
need it. `dsh-pdf-reader/reference/dsh-client-ui-sidebar-documentpreview-README.md:32`:

> “Two Session-scoped list child slots hand the previewed file to other plugins
> once its metadata reports a Host path, both with `absolutePath` as the owner
> prop: `sidebar.right.tab.document.actions` renders after the header's own
> controls … and `sidebar.right.tab.document.unpreviewable` …”

`:35` documents the renderer extension point:

> `ctx.documentPreviews.register({ id, extensions, binaryExtensions?, priority,
> title, loading, wrap? })` plus a body in the keyed
> `sidebar.right.tab.document` slot.

**c) The proof that this works in production.** `dsh-pdf-search` is a working
third-party client plugin installed in the active profile:

- `~/.dsh/profiles/desktop/package.json:10` and `:20` — bundle row and
  `link:/Users/zyl/my_projects/learn /math/dsh-pdf-search`.
- `/Users/zyl/my_projects/learn /math/dsh-pdf-search/src/client/index.ts:12,18-24`
  — `inject: ['slots']`, then
  `ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({...}, PdfSearchAction))`.
- `/Users/zyl/my_projects/learn /math/dsh-pdf-search/src/client/action.ts:65-69,162-190`
  — it locates the preview via `data-textpreview-body`, the scroll container via
  `data-document-zoom-scrollport`, and pages via `[data-pdf-page]`. The same
  markers power this prototype.
- `/Users/zyl/my_projects/learn /math/dsh-pdf-search/src/index.ts:17,73-137` —
  its host half registers a prefix route with `ctx.webServer.register`.

`dsh-better-sidebar` is also installed and documents the same boundary:
`~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/README_EN.md:175-176`
states that images, PDF, spreadsheets, and Office are rendered by DSH’s own
`ui-sidebar-documentpreview`, and its service API (`registerTab` /
`registerFileViewer`) is documented at `:332-341`.

**Verdict:** yes, a client plugin can add a right-side panel, a header control,
or even replace the PDF renderer. The native preview’s header slot is the
lowest-risk insertion point.

### 1.3 Existing PDF viewer / search plugins

| Where | What it does | Relevance |
|---|---|---|
| Host `ui-sidebar-documentpreview` | Full PDF.js preview in the right sidebar, zoom, selection, lazy pages, Office→PDF | Already covers feature 1 |
| `dsh-pdf-search` (installed, local link) | Ctrl/Cmd+F full-text search in the native PDF preview, next/previous hit, scrolls the target page into view; host route extracts text with `pdfjs-dist` | Covers most of feature 2; no page box, no image rendering |
| `dsh-better-sidebar` (installed) | File tree/editor/side chat; explicitly delegates PDF to the host preview | Not a PDF viewer |
| `@ggboy123/dsh-paper-reader` 1.5.1 | Full paper-reading workbench: library + PDF reader + page-number-aware chat, click a page to jump back, selection-to-question, translation | Closest existing product to the full vision; heavyweight (MinerU, translation, own reader) |
| `dsh-pdf` 0.1.0 | Host-side tools: extract text, metadata, page ranges via `pdfjs-dist` | Text only; math still mangled |
| `dsh-pdf-reader` 0.2.0 (**name collision**) | PyMuPDF tools `pdf_scan` / `pdf_read_page` / `pdf_render_region`; renders detected figure/table regions as PNG paths for `read_image` | Directly overlaps this task’s AI-side idea; requires Python + PyMuPDF |
| `@zhtx2026/dsh-pdf` 0.1.1 | Tools `pdf_info` / `pdf_extract_text` / `pdf_render_page`; pdfjs + canvas | Similar, different runtime |
| `dsh-quicklook` | Space-to-preview overlay for image/PDF/text | Viewer UX, not AI context |

Web evidence: <https://github.com/sunshine-lang/dsh-pdf>,
<https://github.com/GGboya/dsh-paper-reader>,
<https://www.npmjs.com/package/dsh-pdf-reader>,
<https://github.com/zengqingsong/dsh-sidebar-frog>.

**Important:** the package name `dsh-pdf-reader` is already published on npm
(v0.2.0). Our local directory keeps the requested name, but it must be renamed
before publishing (`dsh-ladr-reader`, `@scope/dsh-pdf-reader`, …).

### 1.4 What the AI can already do with a PDF

- **`read` cannot read PDFs.** `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-tool-fs/README.md:171`:
  “`read` handles UTF-8 text files only … PDF, audio, and video remain deferred.”
- **`read_image` exists and returns an image block.**
  Local tool schema in this session: `read_image` takes a PNG/JPEG/WebP/GIF path.
  Package evidence:
  - `dsh-tool-fs/README.md:35` — reads the raster, persists it through
    `ctx.attachments.saveImage`, “returns an image block beside a small metadata
    envelope”, and requires the routed model to declare image input.
  - `:41`, `:48`, `:126-134` — the block is durable, is emitted into
    `tool/result`, and is logged before the next request.
  - `:173` — the image result card is generic, but the model still receives the
    image.
- **Tool results can carry images by type, not by convention.**
  `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts:54-73`:
  `ImageBlock { type: 'image'; attachment: ImageAttachmentRef }`,
  `ToolResultBlock { content: ContentBlock[] }`.
  `@deepseek-ai/dsh-llm/lib/types/content.d.ts:20-28` documents
  `contentHasImage` as the recursive walk over **nested tool-result content**.
  This is the critical mechanism the whole plan depends on, and it is
  first-class.
- **Image admission limits** (`dsh-attachment-local/README.md:7`): 20 images,
  200 MiB source bytes per message; 20 MiB / 64 MP / 8192 px per image;
  normalized long edge 2048 px by default. A 750×1272 page render is accepted;
  very large whole-page renders are downscaled at request time, which is why
  cropping is part of the skill.
- **The route must declare image input.** The active profile config
  (`~/.dsh/profiles/desktop/cordis.patch.yml`) declares `qwen3.8-flash-next`
  with `input: [text, image]`, so `read_image` is usable in this session.
  `read_image` itself succeeded during verification (Section 3.2).
- **Office skills.** `dsh-skill-office` has `office-render` (LibreOffice Kit can
  rasterize requested PDF pages) and `office-export-pdf`, but no PDF text
  reader. `office-render/SKILL.md` explicitly batches PDF pages and then uses
  the session image tool. It needs the Office sidecar and is much heavier than
  PDFKit on macOS.
- **Skill discovery.** `dsh-skill-filesystem/README.md:35-38`: project skills
  live at `<projectRoot>/.dsh/skills`; user skills at `<dshHome>/skills`.
  This workspace has no `.git`, so its project root is the workspace itself.

**Conclusion:** the AI already has the receiving half (vision + image blocks).
The missing half was a dependency-free PDF→PNG renderer, plus instructions on
how to locate pages and avoid the text-layer math trap.

---

## 2. The four requested features, evaluated honestly

### 2.1 Right-side PDF preview — **already exists; do not build**

Native, in the right sidebar, with PDF.js, fit-width/zoom, text selection,
lazy rendering, reload, auto-refresh, and Office→PDF reuse. A replacement would
lose these and fight the host. Our plugin composes with it through the header
slot instead.

### 2.2 Basic search + page navigation — **mostly exists; page jump was missing**

- Search already exists in the installed `dsh-pdf-search`: Ctrl/Cmd+F, hit
  counter, Enter/Shift+Enter, highlight, and it scrolls the matching page into
  view (which also forces lazy pages to render).
- Native navigation is continuous scrolling only; there is no page-number box
  and no current-page readout.
- Our header prototype adds exactly that: current page follows scroll, type a
  page and press Enter to jump. It is additive and needs no host route.
- Feasibility: high. Live test is blocked only by profile installation.

### 2.3 “Share current page with this chat session” — **not native; feasible and prototyped**

There is no native share action. What exists is a clean path to the composer:

- The preview exposes the Session-scoped `sidebar.right.tab.document.actions`
  slot with `absolutePath` (`documentpreview-README.md:32`).
- Session-scoped slot components receive `sessionId` (proven by the built-in
  `SessionOpenInAppAction` in `ui-open-in-app`:
  `const { sessionId, useSessions } = props`).
- The public conversation service exposes
  `ctx.get('conversation').input.for(ctx.sessions.scope(sessionId))`, whose
  `input.state.getSnapshot().draft` and `input.setDraft(next)` are used by
  `dsh-better-sidebar` for its “@file” insertion
  (`~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/lib/client.js`,
  `appendToDraft` / `insertFileReference`).

Our prototype appends `PDF: <absolute path> — read page <N>` to the existing
draft. It falls back to the public `useInput`/`inputActions` pair if the session
standard kit is injected, and to the clipboard if neither is available.
**Not live-verified**: installing into `~/.dsh/profiles/desktop` is outside this
session’s write scope.

### 2.4 A skill that teaches the AI to index/query a PDF — **feasible and written**

`dsh-pdf-reader/SKILL.md` (name `pdf-reader`) encodes:

1. `pdfkit info` → page count, page labels, outline with **physical + printed**
   page numbers, and the dominant printed-page offset.
2. `pdfkit search` / a cached per-page text dump + grep → physical page.
3. `pdfkit render --pages … --scale 2` → PNG.
4. `read_image` on the PNGs.
5. `--crop` at 3× when sub/superscripts are too small for the request image
   budget.

Pitfalls covered: printed page ≠ PDF page, front-matter labels, text extraction
mangling math, scanned pages, lazy preview rendering, provider image budgets,
and the sandbox-safe Swift build recipe.

Not yet registered with the running harness, because the skill root
(`<workspace>/.dsh/skills`) is outside the allowed write paths. Exact install
command is in Section 5.

---

## 3. What was built, and proof it runs

### 3.1 `tools/pdfkit` — Swift + PDFKit helper

Files:

- `dsh-pdf-reader/tools/pdfkit.swift` (358 lines)
- `dsh-pdf-reader/tools/pdfkit` (compiled arm64 binary, 138 KB)

Subcommands:

```
pdfkit info   <pdf>
pdfkit text   <pdf> [--pages 1-20,25] [--out file]
pdfkit search <pdf> --query "term" [-i] [--context 60]
pdfkit render <pdf> --pages 292-293 [--scale 2] [--out dir] [--prefix name]
pdfkit render <pdf> --pages 293 --scale 3 --crop 0,0,1,0.55   # top 55%
```

Build command that works under the file sandbox (both the temp dir and clang
module cache must be inside the workspace):

```sh
mkdir -p .tmp .swiftcache
TMPDIR="$PWD/.tmp" swiftc -module-cache-path "$PWD/.swiftcache" -O \
  dsh-pdf-reader/tools/pdfkit.swift -o dsh-pdf-reader/tools/pdfkit
```

Observed: `swiftc` exit 0, binary 138 KB. (`TMPDIR` alone is not enough; the
default module cache under `/var/folders` is blocked.)

First implementation note: setting `NSBitmapImageRep.size` *and* scaling the
CGContext by 2 crops the output to a magnified quadrant. The correct recipe is
to make the bitmap 2× larger and leave `rep.size` at the page size in points, so
the context’s base CTM supplies the 2× device scale. This was caught by
inspecting the PNG and fixed; the saved artifacts are from the fixed version.

#### Observed `info` output on the LADR book

```
pages: 410
page-labels(first 30): 1=C1, 2=i, 3=ii, 4=4, 5=iii, ..., 20=xvii, 21=1, 22=2, ...
printed-page-offset: physical = printed + 20  (390 numeric labels agree)
outline:
  - Chapter 7 Operators on Inner Product Spaces  [p247 · printed 227]
    - 7E Singular Value Decomposition  [p290 · printed 270]
```

The offset line is computed from 390 numeric page labels, not hard-coded.

#### Observed search output

```sh
./dsh-pdf-reader/tools/pdfkit search "Linear Algebra Done Right-Springer (2024).pdf" \
  --query "singular value decomposition" --ignore-case
```

→ `53 hit(s) on 28 page(s)`, first hits `p11`, `p12`, `p17`, `p18`, `p247`,
`p290`, `p291`, `p293` (stderr summary). This is the “index/query” half of the
skill.

#### Observed text extraction (why images are necessary)

`pdfkit text … --pages 151-152` returns lines such as:

```
Suppose 𝑚 is a nonnegative integer and 𝑝 ∈ 𝒫 𝑚(𝐂) ...
there exist 𝑟 ∈ 𝒫 𝑛 − 1(𝐂) and 𝑠 ∈ 𝒫 𝑚 − 1(𝐂) such that
```

Subscripts are flattened into separate runs, `P_{n-1}` becomes `𝒫 𝑛 − 1(𝐂)`,
and theorem numbers/proof structure are lost. This confirms the user’s
complaint and is exactly what the rendered page avoids.

### 3.2 Rendered-page proof

Commands (rerun after cleanup; deterministic byte sizes):

```sh
./dsh-pdf-reader/tools/pdfkit render "Linear Algebra Done Right-Springer (2024).pdf" \
  --pages 292 --scale 2 --out dsh-pdf-reader/artifacts --prefix ladr
./dsh-pdf-reader/tools/pdfkit render "Linear Algebra Done Right-Springer (2024).pdf" \
  --pages 293 --scale 3 --crop 0,0,1,0.55 --out dsh-pdf-reader/artifacts --prefix ladr
```

Observed:

```
dsh-pdf-reader/artifacts/ladr-292.png       750x1272   241,796 bytes
dsh-pdf-reader/artifacts/ladr-293-crop.png  1125x1049  252,028 bytes
```

`read_image` on `ladr-292.png` returned a real image (not a path error), and the
model-visible image showed theorem 7.68 (“role of positive singular values”),
its proof, the eigenvalue/singular-value comparison table, and theorem 7.69
with subscripts and `T*T` intact. `read_image` on the crop showed theorem 7.70
(SVD) and equation 7.71 with clean `s₁, …, sₘ`, `⟨v, e₁⟩`, and `T*T e_k = s_k² e_k`.
This is the end-to-end proof: **Swift render → PNG → `read_image` → image in the
model context**.

Artifacts are kept at `dsh-pdf-reader/artifacts/` (about 500 KB). The PNGs are
also useful when the user wants to see the exact page.

### 3.3 `SKILL.md`

`dsh-pdf-reader/SKILL.md` (159 lines) is ready to register. It is written to be
portable: it derives `PDFKIT="$PWD/dsh-pdf-reader/tools/pdfkit"`, includes the
build recipe, and falls back to `office-render` / third-party PDF tool plugins
on non-macOS hosts.

### 3.4 Client plugin prototype (header page tools)

Files:

- `dsh-pdf-reader/lib/client.js` (368 lines, hand-written CJS factory; React is
  the only external)
- `dsh-pdf-reader/lib/index.js` (no-op host half)
- `dsh-pdf-reader/package.json`
- `dsh-pdf-reader/cordis.patch.yml`
- `dsh-pdf-reader/test/plugin.test.mjs`

What it does:

- `inject: ['slots']`; registers into
  `sidebar.right.tab.document.actions` with id `pdf-page-tools`, order `-6`.
- Resolves the preview body with `data-textpreview-body`, the real scrollport
  with `data-document-zoom-scrollport`, and pages with `[data-pdf-page]` — the
  same markers `dsh-pdf-search` uses.
- Shows `[page] / total`; the input jumps on Enter and the readout follows
  scrolling (rAF-throttled scroll listener + MutationObserver).
- Share appends `PDF: <path> — read page <N>` to the composer through
  `conversation.input.for(sessions.scope(sessionId))`, preserving the existing
  draft; falls back to `inputActions.setDraft`, then clipboard.
- No host route, no PDF parsing in the browser, no renderer takeover.

Headless test command and observed output:

```sh
$ node dsh-pdf-reader/test/plugin.test.mjs
ok: bundle loads, slot registration, page math, pane resolution, component render, composer hook
```

The test evaluates the real bundle through a fake `window.__ModuleLoader__`,
asserts the slot name/id/order, checks `pickPage` and `formatReference`, resolves
a real jsdom preview body and scrollport, server-renders the component (with and
without the session standard kit), and verifies `appendToComposer` preserves an
existing draft.

`dsh-pdf-search`’s own tests were not run (they belong to the other plugin).

**Not done:** the plugin is not installed in `~/.dsh/profiles/desktop`, so it has
not been seen in the live browser. That write is outside this session’s scope.

---

## 4. What is blocked, and why

1. **Live GUI verification of the client plugin.** Installing it requires
   writing `~/.dsh/profiles/desktop` (dependency, bundle list, patch layer).
   The session’s write scope is the workspace, and approval prompts are
   disabled. I did not modify the installed app bundle or the profile.
2. **Skill registration.** The running harness discovers project skills at
   `<workspace>/.dsh/skills` (`dsh-skill-filesystem/README.md:35`), which is
   outside the allowed write paths. The skill file itself is ready.
3. **No proof that the header action appears on top of *every* renderer state**
   (e.g. Office→PDF). The slot is documented as appearing “in every state that
   shows the header” and is Session-scoped; the prototype only targets the PDF
   byte renderer by DOM, so it is inert on non-PDF files.
4. **Name collision.** `dsh-pdf-reader` is already an npm package; publishing
   this prototype under that name would conflict.

---

## 5. Recommendation

**Do not build a full PDF viewer.** The host already has a better one than a
prototype would produce, and `dsh-pdf-search` already adds search. The user’s
real pain — the model can’t see the math — is solved by the lighter workflow:

### Recommended now (no profile changes, highest value)

1. Install the skill (project scope; run from the workspace):

   ```sh
   mkdir -p "/Users/zyl/my_projects/learn /math/.dsh/skills"
   ln -sfn "/Users/zyl/my_projects/learn /math/dsh-pdf-reader" \
     "/Users/zyl/my_projects/learn /math/.dsh/skills/pdf-reader"
   ```

   The skill name comes from frontmatter (`pdf-reader`), so the directory may be
   named anything. The watcher should publish the new catalog; a new session is
   the safe check.

2. Ask the AI for a section as usual. Expected behavior: `pdfkit info` → offset,
   `pdfkit search` → physical page, `pdfkit render` → PNG, `read_image` → answer
   with both page numbers.

3. Keep `.swiftcache/` (211 MB) only if rebuilding; otherwise delete it. The
   compiled `tools/pdfkit` is self-contained.

### If the in-GUI page jump / share button is wanted

Finish and install the small plugin (not a viewer):

```sh
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add "/Users/zyl/my_projects/learn /math/dsh-pdf-reader"
```

Then restart the app and open a PDF. Expected: `[page] / total` and a `↗` share
button in the preview header; Enter jumps; share appends a page reference to the
composer. If the action does not appear, the first thing to check is whether
`ctx.slots.inject` fired (the same failure mode `dsh-pdf-search` documents) and
whether the package was linked under its package name.

Before publishing anywhere, rename the package (npm has `dsh-pdf-reader@0.2.0`).

### If the user wants the complete in-GUI reading product

Evaluate `@ggboy123/dsh-paper-reader` first. It already provides a library +
PDF reader + page-number-aware chat + selection-to-question. It is much larger
and brings MinerU/translation machinery; it may also compete with the current
native preview. Installing it is a user decision, not something to fold into
this prototype.

### Suggested follow-ups (ordered)

1. Install the skill and use it on a real question; measure whether 2× full page
   is enough, or whether the skill should default to top/bottom half crops for
   this book.
2. Live-test the client plugin, then decide whether to keep the page box, the
   share button, or both.
3. If share should produce a clickable DSH file chip rather than plain text, use
   the `slash/input-insert-reference` path from `dsh-better-sidebar` instead of
   plain `setDraft`; that requires workspace-relative paths and the `@` grammar.
4. Consider a host tool (`pdf_render`) that returns image blocks directly,
   eliminating the two-step `render` + `read_image`; the attachment API supports
   it, but it is not necessary for the current pain and is harder to verify.

---

## 6. Risks and sharp edges

- **Page offsets are per-document.** LADR is `+20`, computed from 390 labels.
  Never reuse it for another PDF; `info` recomputes it.
- **Text extraction is not evidence for math.** Use it to locate, not to quote.
- **In-memory DOM markers are private.** `[data-pdf-page]`,
  `[data-textpreview-body]`, and `[data-document-zoom-scrollport]` are internal
  to the current host build. Both `dsh-pdf-search` and this plugin depend on
  them; a DSH upgrade could rename them. The official slot API is stable; the
  markers are not.
- **Image budget.** A full 750×1272 page may be downscaled for the request.
  Dense subscripts should be cropped at 3×, not rendered as a larger full page.
- **Scanned PDFs.** No text layer → search/index unavailable; render only.
- **macOS-only renderer.** PDFKit is a macOS framework. The skill documents the
  `office-render` fallback and third-party tool plugins.
- **Slot prop assumption.** The prototype reads `sessionId` and `absolutePath`
  from the slot; the built-in `ui-open-in-app` proves session-scoped slots get
  `sessionId`, and `documentpreview-README.md:32` proves `absolutePath`. Live
  confirmation is still pending.
- **Skill discovery root.** Without `.git`, the project root is the current
  workspace. If the workspace is later moved under a Git repo, install the skill
  under that repo’s `.dsh/skills` instead.

---

## Appendix A — Evidence map

| Claim | Path | Lines |
|---|---|---|
| Native PDF preview, bytes, lazy pages, text layer | `dsh-pdf-reader/reference/dsh-client-ui-sidebar-documentpreview-README.md` | 57, 64, 66, 126 |
| `sidebar.right.tab.document.actions` slot, `absolutePath` | same | 32 |
| `ctx.documentPreviews.register` | same | 35 |
| No shared search; no model experience | same | 131, 140 |
| `ctx.sidebarRightTabs.register`, body slot, navigation | `dsh-pdf-reader/reference/dsh-client-ui-sidebar-right-README.md` | 48, 83, 84, 93 |
| Working slot-based plugin | `dsh-pdf-search/src/client/index.ts` | 12, 18–24 |
| DOM markers and scrollport resolution | `dsh-pdf-search/src/client/action.ts` | 162–190 |
| Installed plugin link | `~/.dsh/profiles/desktop/package.json` | 10, 20 |
| `read` cannot read PDFs | `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-tool-fs/README.md` | 171 |
| `read_image` returns an image block | same | 35, 41, 48, 126–134 |
| Image block inside tool results | `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm/lib/types/types.d.ts` | 54–73 |
| Recursive image walk over tool results | `.../dsh-llm/lib/types/content.d.ts` | 20–28 |
| Image limits | `.../dsh-attachment-local/README.md` | 7 |
| Skill discovery roots | `.../dsh-skill-filesystem/README.md` | 35–38 |
| Conversation input service + `setDraft` | `~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/lib/client.js` | `appendToDraft` / `insertFileReference` |
| Host owns PDF preview | `dsh-better-sidebar/README_EN.md` | 175–176 |

## Appendix B — Prototype file map

```
dsh-pdf-reader/
  DESIGN.md                       this report
  SKILL.md                        installable skill (name: pdf-reader)
  package.json                    client plugin manifest
  cordis.patch.yml                bundle patch row
  lib/client.js                   header page box + share button
  lib/index.js                    no-op host half
  tools/pdfkit.swift              PDFKit CLI source
  tools/pdfkit                    compiled arm64 binary (138 KB)
  test/plugin.test.mjs            headless bundle/slot/composer tests
  artifacts/info.txt              observed info output
  artifacts/ladr-292.png          750x1272 full page
  artifacts/ladr-293-crop.png     1125x1049 top-half crop at 3x
  reference/…                     extracted API READMEs + package.jsons
```
