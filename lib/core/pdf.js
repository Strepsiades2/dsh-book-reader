/**
 * dsh-pdf-reader core / pdf.js
 *
 * Pure-Node PDF access for the host half of dsh-pdf-reader:
 *
 *   - a small LRU cache of parsed PDF.js documents (path + mtime + size),
 *   - metadata (page labels, detected printed-page offset, resolved outline),
 *   - whitespace-normalised page text,
 *   - full-text search with physical *and* printed page numbers.  Search is
 *     literal-ish on NFKC-normalised text, with compact (space-insensitive)
 *     and all-terms fallbacks, body pages ranked before front matter.
 *
 * Design constraints that shaped this file:
 *
 *   - pdfjs-dist is loaded lazily, and only after the three DOM globals that
 *     its canvas path touches (DOMMatrix / Path2D / ImageData) are installed
 *     from @napi-rs/canvas.  Loading pdf.js before those globals breaks
 *     rendering in Node with a "DOMMatrix is not defined" error.
 *   - PDF.js runs its "fake worker" in-process in Node (no worker thread).
 *     That is what makes in-process rendering possible, but it also means the
 *     cached document owns real memory until it is destroyed.
 *   - Nothing here shells out; no Swift/PDFKit, no Python.
 *
 * The public interface is documented in ./README.md.  Names starting with
 * `__` are internal exports used by render.js and are not part of the host
 * contract.
 */

import { createRequire } from 'node:module'
import { stat } from 'node:fs/promises'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

/** Maximum number of parsed documents kept open at once. */
const MAX_OPEN_DOCUMENTS = 4

/** Whole-document load guard (requirement: ~60 s; corrupt files may hang). */
export const PDF_LOAD_TIMEOUT_MS = 60_000

/** Resolved once, lazily: pdfjs-dist package root (fonts/cmaps/wasm live here). */
let pdfjsPackageDir = null
function getPdfjsPackageDir() {
  if (!pdfjsPackageDir) pdfjsPackageDir = dirname(require.resolve('pdfjs-dist/package.json'))
  return pdfjsPackageDir
}

// ---------------------------------------------------------------------------
// PDF.js loader + DOM polyfills
// ---------------------------------------------------------------------------

let pdfjsPromise = null

/**
 * Load pdfjs-dist/legacy/build/pdf.mjs after installing the DOM globals its
 * Node canvas path needs.  Exported only for render.js; the host should not
 * call this directly.
 *
 * @returns {Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')>}
 */
export async function __loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // Deliberately a dynamic import: the polyfills must exist *before* the
      // pdf.js module evaluates its canvas-dependent code.
      const canvas = await import('@napi-rs/canvas')
      // Assign unconditionally: another plugin in the same host process may
      // already have installed a *different* Path2D/DOMMatrix (or pdf.js's own
      // JS shim) on globalThis. A `??=` here would then keep the foreign one,
      // and pdf.js's `ctx.fill(path)` fails inside @napi-rs/canvas with
      // "Value is none of these types String, Path" because the native
      // binding does not recognise a foreign Path2D instance.
      globalThis.DOMMatrix = canvas.DOMMatrix
      globalThis.Path2D = canvas.Path2D
      globalThis.ImageData = canvas.ImageData
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
      // The pdf.js module may have been imported earlier by someone else; if it
      // warned "Cannot polyfill Path2D", re-assert after import as well.
      globalThis.DOMMatrix = canvas.DOMMatrix
      globalThis.Path2D = canvas.Path2D
      globalThis.ImageData = canvas.ImageData
      return pdfjs
    })().catch((error) => {
      pdfjsPromise = null // allow a later retry after a transient failure
      throw error
    })
  }
  return pdfjsPromise
}

/** Options shared by every getDocument() call. */
function documentOptions(absolutePath) {
  const packageDir = getPdfjsPackageDir()
  return {
    // In Node, a plain absolute filesystem path is correct here.  A file://
    // URL works too, but a *wrong* path yields the misleading pdf.js error
    // "Unexpected server response (0) while retrieving PDF".
    url: absolutePath,
    useSystemFonts: true,
    isEvalSupported: false,
    // Keep font/CMap/wasm asset loading inside the installed package.  The
    // trailing slash is required by pdf.js's factory URL validation.
    standardFontDataUrl: join(packageDir, 'standard_fonts') + '/',
    cMapUrl: join(packageDir, 'cmaps') + '/',
    cMapPacked: true,
    wasmUrl: join(packageDir, 'wasm') + '/',
  }
}

// ---------------------------------------------------------------------------
// Paths, file stats, errors
// ---------------------------------------------------------------------------

function normalizePdfPath(pathLike) {
  if (typeof pathLike !== 'string' || pathLike.trim() === '') {
    throw new TypeError('PDF path must be a non-empty string')
  }
  if (pathLike.startsWith('file://')) {
    try {
      return fileURLToPath(pathLike)
    } catch (error) {
      throw new Error(`Invalid file:// PDF URL: ${pathLike}`, { cause: error })
    }
  }
  return resolvePath(pathLike)
}

async function statPdf(absolutePath) {
  let stats
  try {
    stats = await stat(absolutePath)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      const wrapped = new Error(`PDF not found: ${absolutePath}`, { cause: error })
      wrapped.code = 'PDF_NOT_FOUND'
      throw wrapped
    }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      const wrapped = new Error(`PDF is not readable: ${absolutePath}`, { cause: error })
      wrapped.code = 'PDF_NOT_READABLE'
      throw wrapped
    }
    throw new Error(`Cannot stat PDF ${absolutePath}: ${error?.message || error}`, { cause: error })
  }
  if (!stats.isFile()) {
    const error = new Error(`PDF path is not a regular file: ${absolutePath}`)
    error.code = 'PDF_NOT_FILE'
    throw error
  }
  return stats
}

function wrapLoadError(error, absolutePath) {
  if (error?.code === 'PDF_LOAD_TIMEOUT') return error

  const name = error?.name || ''
  const message = error?.message || String(error)

  if (name === 'PasswordException' || /password/i.test(message)) {
    const wrapped = new Error(
      `PDF is encrypted or password-protected and cannot be opened: ${absolutePath}`,
      { cause: error },
    )
    wrapped.code = 'PDF_ENCRYPTED'
    return wrapped
  }
  if (name === 'InvalidPDFException') {
    const wrapped = new Error(
      `PDF is corrupt or not a valid PDF: ${absolutePath} (${message})`,
      { cause: error },
    )
    wrapped.code = 'PDF_CORRUPT'
    return wrapped
  }
  if (name === 'MissingPDFException') {
    const wrapped = new Error(`PDF not found: ${absolutePath}`, { cause: error })
    wrapped.code = 'PDF_NOT_FOUND'
    return wrapped
  }
  if (name === 'AbortException') {
    const wrapped = new Error(`PDF load was aborted: ${absolutePath} (${message})`, { cause: error })
    wrapped.code = 'PDF_ABORTED'
    return wrapped
  }
  if (name === 'ResponseException' || /Unexpected server response/i.test(message)) {
    const wrapped = new Error(
      `Unable to read PDF data from ${absolutePath} (${message}). ` +
        'Check that the path exists and is a regular file, not a directory.',
      { cause: error },
    )
    wrapped.code = 'PDF_UNREADABLE'
    return wrapped
  }

  const wrapped = new Error(`Failed to open PDF ${absolutePath}: ${message}`, { cause: error })
  wrapped.code = 'PDF_LOAD_FAILED'
  return wrapped
}

// ---------------------------------------------------------------------------
// Document loading + LRU cache
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CacheEntry
 * @property {string} path
 * @property {number} mtimeMs
 * @property {number} size
 * @property {import('pdfjs-dist/types/src/display/api').PDFDocumentProxy|null} doc
 * @property {import('pdfjs-dist/types/src/display/api').PDFDocumentLoadingTask|null} task
 * @property {Promise<CacheEntry>|null} loadPromise
 * @property {Promise<Meta>|null} metaPromise
 * @property {Meta|null} meta
 * @property {Promise<Info>|null} infoPromise
 * @property {Info|null} info
 * @property {number} active
 * @property {number} lastUsed
 * @property {boolean} stale
 * @property {boolean} destroyed
 */

/** @type {Map<string, CacheEntry>} */
const cache = new Map()
let accessClock = 0

async function loadDocument(absolutePath) {
  const pdfjs = await __loadPdfjs()
  const task = pdfjs.getDocument(documentOptions(absolutePath))

  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `Timed out after ${PDF_LOAD_TIMEOUT_MS / 1000}s loading PDF: ${absolutePath}`,
      )
      error.code = 'PDF_LOAD_TIMEOUT'
      // The rejection below is handled by the catch in the try block, which
      // performs the actual best-effort task.destroy().  Keep this timer
      // referenced so a stalled load cannot let the process exit silently.
      reject(error)
    }, PDF_LOAD_TIMEOUT_MS)
  })

  // If the timeout wins, the task's later rejection must not become an
  // unhandled rejection.
  task.promise.catch(() => {})

  try {
    const doc = await Promise.race([task.promise, timeout])
    return { doc, task }
  } catch (error) {
    Promise.resolve(task.destroy()).catch(() => {})
    throw wrapLoadError(error, absolutePath)
  } finally {
    clearTimeout(timer)
  }
}

/** @param {CacheEntry} entry */
function destroyEntry(entry) {
  if (entry.destroyed) return Promise.resolve()
  entry.destroyed = true
  const task = entry.task
  entry.task = null
  entry.doc = null
  return Promise.resolve(task?.destroy?.()).catch(() => {})
}

/** Remove an entry from the map and destroy it once no caller is using it. */
function retireEntry(entry) {
  if (cache.get(entry.path) === entry) cache.delete(entry.path)
  entry.stale = true
  if (entry.active === 0) void destroyEntry(entry)
}

function trimCache() {
  while (cache.size > MAX_OPEN_DOCUMENTS) {
    let victim = null
    for (const entry of cache.values()) {
      if (entry.active !== 0) continue
      if (!victim || entry.lastUsed < victim.lastUsed) victim = entry
    }
    if (!victim) break // every open document is in use; shrink after release
    retireEntry(victim)
  }
}

function createEntry(absolutePath, stats) {
  /** @type {CacheEntry} */
  const entry = {
    path: absolutePath,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    doc: null,
    task: null,
    loadPromise: null,
    metaPromise: null,
    meta: null,
    infoPromise: null,
    info: null,
    active: 0,
    lastUsed: 0,
    stale: false,
    destroyed: false,
  }

  entry.loadPromise = loadDocument(absolutePath)
    .then(({ doc, task }) => {
      const current = cache.get(absolutePath)
      if (entry.stale || (current && current !== entry)) {
        // The cache entry was closed or replaced while loading.  No caller can
        // obtain this document (this promise rejects), so destroy it now.
        void Promise.resolve(task.destroy()).catch(() => {})
        throw wrapLoadError(new Error('PDF cache entry was closed while loading'), absolutePath)
      }
      entry.doc = doc
      entry.task = task
      // Every entry is added before its load completes, so `current` is this
      // entry in the normal path.
      return entry
    })
    .catch((error) => {
      if (cache.get(absolutePath) === entry) cache.delete(absolutePath)
      entry.stale = true
      if (entry.active === 0) void destroyEntry(entry)
      throw error
    })

  // If a caller abandons the load (e.g. closePdf races it), don't leave an
  // unhandled rejection behind; real awaiters still receive the rejection.
  entry.loadPromise.catch(() => {})
  return entry
}

/**
 * Acquire a cached document.  Checks mtime+size on every call so a replaced
 * file is reopened instead of serving stale pages.
 *
 * @param {string} pathLike
 * @returns {Promise<CacheEntry>}
 */
async function acquire(absoluteOrRelativePath) {
  const absolutePath = normalizePdfPath(absoluteOrRelativePath)
  const stats = await statPdf(absolutePath)

  let entry = cache.get(absolutePath)
  if (entry && (entry.mtimeMs !== stats.mtimeMs || entry.size !== stats.size)) {
    retireEntry(entry)
    entry = null
  }

  if (!entry) {
    entry = createEntry(absolutePath, stats)
    cache.set(absolutePath, entry)
  }

  // Mark as active *before* trimming so the just-created entry cannot be
  // chosen as the LRU victim.
  entry.active += 1
  entry.lastUsed = ++accessClock
  trimCache()

  try {
    await entry.loadPromise
  } catch (error) {
    releaseEntry(entry)
    throw error
  }
  return entry
}

/** @param {CacheEntry} entry */
function releaseEntry(entry) {
  entry.active = Math.max(0, entry.active - 1)
  entry.lastUsed = ++accessClock
  if (entry.stale && entry.active === 0) {
    void destroyEntry(entry)
  } else {
    trimCache()
  }
}

async function withEntry(pathLike, fn) {
  const entry = await acquire(pathLike)
  try {
    return await fn(entry)
  } finally {
    releaseEntry(entry)
  }
}

/**
 * Close and evict the cached document for a path.
 *
 * If a call is still using the document, it stays alive until that call
 * releases it; this function does not wait for in-flight renders.
 *
 * @param {string} path
 * @returns {Promise<boolean>} true if a cached entry was removed
 */
export async function closePdf(path) {
  let absolutePath
  try {
    absolutePath = normalizePdfPath(path)
  } catch {
    return false
  }
  const entry = cache.get(absolutePath)
  if (!entry) return false
  retireEntry(entry)
  if (entry.active === 0) await destroyEntry(entry)
  return true
}

// ---------------------------------------------------------------------------
// Page labels / printed-page offset
// ---------------------------------------------------------------------------

/** @typedef {{pdf:number, printed:number|string|null}} PageLabel */
/** @typedef {{title:string, pdf:number, printed:number|string|null, depth:number}} OutlineEntry */
/** @typedef {{pageCount:number, labels:PageLabel[], printedOffset:number|null, outline:OutlineEntry[]}} Info */
/** @typedef {{pageCount:number, labels:PageLabel[], printedOffset:number|null}} Meta */

function parseNumericLabel(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const number = Number(trimmed)
  return Number.isSafeInteger(number) ? number : null
}

/**
 * A "printed page" is the label printed on the page: a number for numeric
 * labels, the raw label string for front matter ("xvii", "C1"), or null when
 * the page has no label.
 */
function toPrintedLabel(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const numeric = parseNumericLabel(trimmed)
  return numeric === null ? trimmed : numeric
}

/**
 * Detect the physical→printed offset from PDF page labels.
 *
 * `printedOffset` is defined as `physicalPdfPage - printedPage` (LADR: 20;
 * LADR_Solutions: 1), so callers compute `printed = pdf - printedOffset`.
 * The mode of the per-page deltas is used; ties prefer the delta closest to
 * zero.  Returns null when the document has no numeric page labels.
 *
 * @param {string[]|null} rawLabels
 * @returns {number|null}
 */
function detectPrintedOffset(rawLabels) {
  if (!Array.isArray(rawLabels) || rawLabels.length === 0) return null

  /** @type {Map<number, number>} */
  const counts = new Map()
  for (let index = 0; index < rawLabels.length; index += 1) {
    const printed = parseNumericLabel(rawLabels[index])
    if (printed === null) continue
    const delta = index + 1 - printed
    counts.set(delta, (counts.get(delta) || 0) + 1)
  }

  let best = null
  let bestCount = 0
  for (const [delta, count] of counts) {
    if (
      count > bestCount ||
      (count === bestCount && (best === null || Math.abs(delta) < Math.abs(best)))
    ) {
      best = delta
      bestCount = count
    }
  }
  return best
}

/**
 * @param {CacheEntry} entry
 * @returns {Promise<Meta>}
 */
async function ensureMetadata(entry) {
  if (entry.meta) return entry.meta
  if (!entry.metaPromise) {
    entry.metaPromise = (async () => {
      const pageCount = entry.doc.numPages

      let rawLabels = null
      try {
        rawLabels = await entry.doc.getPageLabels()
      } catch {
        rawLabels = null // encrypted/odd catalog: degrade to no labels
      }
      if (!Array.isArray(rawLabels)) rawLabels = null

      const labels = rawLabels
        ? Array.from({ length: pageCount }, (_, index) => ({
            pdf: index + 1,
            printed: toPrintedLabel(rawLabels[index]),
          }))
        : []

      return {
        pageCount,
        labels,
        printedOffset: detectPrintedOffset(rawLabels),
      }
    })()
      .then((meta) => {
        entry.meta = meta
        return meta
      })
      .catch((error) => {
        entry.metaPromise = null
        throw error
      })
  }
  return entry.metaPromise
}

/** @param {Meta} meta @param {number} pdf */
function printedForPdf(meta, pdf) {
  const label = meta.labels[pdf - 1]
  return label ? label.printed : null
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

async function resolveDestination(doc, dest, namedCache) {
  if (typeof dest === 'string') {
    if (namedCache.has(dest)) return namedCache.get(dest)
    let resolved = null
    try {
      resolved = await doc.getDestination(dest)
    } catch {
      resolved = null
    }
    namedCache.set(dest, resolved)
    return resolved
  }
  if (Array.isArray(dest)) return dest
  return null
}

async function resolvePdfPage(doc, destination, pageCache) {
  if (!Array.isArray(destination) || destination.length === 0) return null
  const ref = destination[0]

  let key
  if (ref && typeof ref === 'object' && Number.isInteger(ref.num)) {
    key = `${ref.num}R${ref.gen ?? 0}`
  } else if (Number.isInteger(ref)) {
    key = `page:${ref}`
  } else {
    return null
  }

  if (pageCache.has(key)) return pageCache.get(key)

  let pdfPage = null
  try {
    if (ref && typeof ref === 'object') {
      // PDF.js getPageIndex() requires a RefProxy ({num, gen}).
      const zeroBased = await doc.getPageIndex(ref)
      if (Number.isInteger(zeroBased)) pdfPage = zeroBased + 1
    } else {
      // Rare malformed explicit destination with a bare page number:
      // treat it as a 1-based physical page if it is in range.
      pdfPage = ref
    }
  } catch {
    pdfPage = null
  }

  if (!Number.isInteger(pdfPage) || pdfPage < 1 || pdfPage > doc.numPages) pdfPage = null
  pageCache.set(key, pdfPage)
  return pdfPage
}

/**
 * Flatten the outline depth-first.  Entries whose destination cannot be
 * resolved are dropped; unresolved children are still attempted.
 *
 * @returns {Promise<OutlineEntry[]>}
 */
async function flattenOutline(doc, items, meta) {
  const result = []
  const namedCache = new Map()
  const pageCache = new Map()

  async function walk(nodes, depth) {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue

      const title = wellFormedText(
        typeof node.title === 'string' ? node.title.replace(/\s+/g, ' ').trim() : '',
      )
      if (title !== '') {
        const destination = await resolveDestination(doc, node.dest, namedCache)
        const pdfPage = await resolvePdfPage(doc, destination, pageCache)
        if (pdfPage !== null) {
          result.push({
            title,
            pdf: pdfPage,
            printed: printedForPdf(meta, pdfPage),
            depth,
          })
        }
      }

      if (Array.isArray(node.items) && node.items.length > 0) {
        await walk(node.items, depth + 1)
      }
    }
  }

  await walk(items, 0)
  return result
}

/** @param {CacheEntry} entry @returns {Promise<Info>} */

/**
 * Document metadata worth surfacing to the model (title/author). Best-effort:
 * a malformed Info dictionary must never fail `getInfo`.
 * @param doc - pdf.js document proxy.
 * @returns `{title, author, subject, creator, producer}` with nulls for absent fields.
 */
async function readDocumentMetadata(doc) {
  const empty = { title: null, author: null, subject: null, creator: null, producer: null }
  try {
    const result = await doc.getMetadata()
    const info = result?.info ?? {}
    const str = (value) => (typeof value === 'string' && value.trim() !== ''
      ? wellFormedText(value.trim())
      : null)
    return {
      title: str(info.Title),
      author: str(info.Author),
      subject: str(info.Subject),
      creator: str(info.Creator),
      producer: str(info.Producer),
    }
  } catch {
    return empty
  }
}

/**
 * Physical size of page 1 in PDF units (1/72 inch), which is enough to tell a
 * book page from a slide or a two-up scan.
 * @param doc - pdf.js document proxy.
 * @param pageCount - total pages.
 * @returns `{width, height}` in points, or null.
 */
async function readFirstPageSize(doc, pageCount) {
  if (!Number.isInteger(pageCount) || pageCount < 1) return null
  try {
    const page = await doc.getPage(1)
    const viewport = page.getViewport({ scale: 1 })
    return { width: Math.round(viewport.width), height: Math.round(viewport.height) }
  } catch {
    return null
  }
}

/**
 * Estimate whether the document has a usable text layer, so the model can tell
 * a normal PDF from a scan before spending image tokens. Samples a spread of
 * pages rather than the whole document.
 * @param doc - pdf.js document proxy.
 * @param pageCount - total pages.
 * @returns `{sampledPages, pagesWithText, ratio, isLikelyScanned}`.
 */
async function sampleTextCoverage(doc, pageCount) {
  const empty = { sampledPages: 0, pagesWithText: 0, ratio: null, isLikelyScanned: null }
  if (!Number.isInteger(pageCount) || pageCount < 1) return empty
  const sampleSize = Math.min(8, pageCount)
  const pages = new Set()
  for (let i = 0; i < sampleSize; i += 1) {
    const page = sampleSize === 1 ? 1 : 1 + Math.round((i * (pageCount - 1)) / (sampleSize - 1))
    pages.add(Math.min(pageCount, Math.max(1, page)))
  }
  let withText = 0
  let sampled = 0
  for (const pdfPage of pages) {
    try {
      const page = await doc.getPage(pdfPage)
      const content = await page.getTextContent()
      const chars = content.items.reduce(
        (total, item) => total + (typeof item?.str === 'string' ? item.str.length : 0),
        0,
      )
      sampled += 1
      if (chars > 20) withText += 1
    } catch {
      // An unreadable sampled page simply does not count; the estimate stays.
    }
  }
  if (sampled === 0) return empty
  const ratio = withText / sampled
  return {
    sampledPages: sampled,
    pagesWithText: withText,
    ratio: Math.round(ratio * 100) / 100,
    isLikelyScanned: ratio < 0.2,
  }
}

async function ensureInfo(entry) {
  if (entry.info) return entry.info
  if (!entry.infoPromise) {
    entry.infoPromise = (async () => {
      const meta = await ensureMetadata(entry)

      let rawOutline = null
      try {
        rawOutline = await entry.doc.getOutline()
      } catch {
        rawOutline = null
      }

      const outline =
        Array.isArray(rawOutline) && rawOutline.length > 0
          ? await flattenOutline(entry.doc, rawOutline, meta)
          : []

      const [documentMetadata, pageSize, textCoverage] = await Promise.all([
        readDocumentMetadata(entry.doc),
        readFirstPageSize(entry.doc, meta.pageCount),
        sampleTextCoverage(entry.doc, meta.pageCount),
      ])

      return {
        path: entry.path,
        pageCount: meta.pageCount,
        labels: meta.labels,
        printedOffset: meta.printedOffset,
        outline,
        documentMetadata,
        pageSize,
        textCoverage,
      }
    })()
      .then((info) => {
        entry.info = info
        return info
      })
      .catch((error) => {
        entry.infoPromise = null
        throw error
      })
  }
  return entry.infoPromise
}

// ---------------------------------------------------------------------------
// Public metadata API
// ---------------------------------------------------------------------------

/**
 * Document info: page count, page labels with printed values, detected
 * printed-page offset, and a flattened, fully resolved outline.
 *
 * @param {string} path
 * @returns {Promise<Info>}
 */
export async function getInfo(path) {
  return withEntry(path, async (entry) => {
    const info = await ensureInfo(entry)
    // Clone arrays/objects so a caller mutating the result cannot poison the
    // cache for the next caller.
    return {
      path: info.path,
      pageCount: info.pageCount,
      labels: info.labels.map((label) => ({ pdf: label.pdf, printed: label.printed })),
      printedOffset: info.printedOffset,
      outline: info.outline.map((entryInfo) => ({ ...entryInfo })),
      documentMetadata: { ...info.documentMetadata },
      pageSize: info.pageSize === null ? null : { ...info.pageSize },
      textCoverage: { ...info.textCoverage },
    }
  })
}

// ---------------------------------------------------------------------------
// Text extraction + search
// ---------------------------------------------------------------------------

function normalizePageText(raw) {
  return raw.replace(/\s+/g, ' ').trim()
}

/**
 * Replace unpaired UTF-16 surrogates with U+FFFD.
 *
 * PDF.js text items can contain a lone high surrogate when a font's ToUnicode
 * map is broken (typical for math fonts split across runs). Such strings are
 * valid JSON (`"\ud835"`) but invalid Unicode for the model API; one such tool
 * result in a Session log makes every later DeepSeek Messages request fail with
 * 400 INVALID_REQUEST. Each plugin string that reaches a Tool result or route
 * response must be well formed.
 *
 * `toWellFormed()` preserves the string length (one code unit -> one), which
 * keeps search offset maps aligned.
 * @param {unknown} value
 * @returns {string}
 */
function wellFormedText(value) {
  if (typeof value !== 'string') return ''
  if (typeof value.toWellFormed === 'function') return value.toWellFormed()
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD',
  )
}

function normalizePdfPageNumber(value, pageCount) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (!Number.isInteger(number) || number < 1 || number > pageCount) {
    const error = new RangeError(
      `PDF page must be an integer between 1 and ${pageCount} (got ${JSON.stringify(value)})`,
    )
    error.code = 'PDF_PAGE_OUT_OF_RANGE'
    throw error
  }
  return number
}

/** @param {CacheEntry} entry @param {number} pdfPage */
async function extractPageText(entry, pdfPage) {
  const page = await entry.doc.getPage(pdfPage)
  try {
    const content = await page.getTextContent()
    const raw = content.items
      .map((item) => (typeof item?.str === 'string' ? item.str : ''))
      .join(' ')
    return wellFormedText(normalizePageText(raw))
  } finally {
    try {
      page.cleanup()
    } catch {
      // cleanup is best-effort; it must never mask the extraction result
    }
  }
}

/**
 * Extract one page's text, whitespace-normalised to a single line.  Joining
 * text items with a space keeps words from different runs separate while
 * making phrases such as "8.46 Jordan form" searchable.
 *
 * @param {string} path
 * @param {number} pdfPage 1-based physical PDF page
 * @returns {Promise<string>}
 */
export async function getPageText(path, pdfPage) {
  return withEntry(path, async (entry) => {
    const pageNumber = normalizePdfPageNumber(pdfPage, entry.doc.numPages)
    try {
      return await extractPageText(entry, pageNumber)
    } catch (error) {
      const wrapped = new Error(
        `Failed to extract text from PDF page ${pageNumber} of ${entry.path}: ${
          error?.message || error
        }`,
        { cause: error },
      )
      wrapped.code = 'PDF_TEXT_EXTRACTION_FAILED'
      throw wrapped
    }
  })
}

// ---------------------------------------------------------------------------
// Query cleanup + searchable text layout
// ---------------------------------------------------------------------------

/** Longest accepted query after wrapper/whitespace cleanup. */
export const MAX_SEARCH_QUERY_LENGTH = 1000

/** At most this many front-matter hits are returned, after body hits. */
export const MAX_FRONT_MATTER_HITS = 3

/**
 * Whole-query wrappers a model commonly adds.  Only a pair surrounding the
 * entire query is stripped, so `don't` or an inner quote is left alone.
 */
const QUERY_WRAPPERS = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['`', '`'],
  ['$', '$'],
]

/** Unicode dash variants deleted for hyphen-insensitive matching. */
const DASH_CHARACTERS = new Set(['-', '\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2015', '\u2212'])

const SOFT_HYPHEN = '\u00ad'
const WHITESPACE_RE = /\s/u

/** Term-AND fallback: ignore one-character noise, examine at most 8 words. */
const MAX_TERM_TOKENS = 8

/** @param {string} value */
function isWhitespace(value) {
  return WHITESPACE_RE.test(value)
}

/**
 * Trim a query, strip wrapping quotes/backticks/`$…$`, collapse whitespace,
 * and reject empty or over-long results.  This is deliberately done before
 * opening the PDF:
 *
 *   "eigenvalue"  -> eigenvalue
 *   `L(V)`        -> L(V)
 *   $T \in L(V)$  -> T \in L(V)
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanSearchQuery(raw) {
  if (typeof raw !== 'string') {
    throw new TypeError('searchPdf: query must be a non-empty string')
  }

  let query = raw.trim()
  let stripped = true
  while (stripped && query.length >= 2) {
    stripped = false
    for (const [open, close] of QUERY_WRAPPERS) {
      if (query.startsWith(open) && query.endsWith(close)) {
        query = query.slice(open.length, query.length - close.length).trim()
        stripped = true
        break
      }
    }
  }

  query = query.replace(/\s+/gu, ' ').trim()
  if (query === '') {
    throw new TypeError('searchPdf: query must be a non-empty string')
  }
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    const error = new RangeError(
      `searchPdf: query is longer than ${MAX_SEARCH_QUERY_LENGTH} characters`,
    )
    error.code = 'PDF_SEARCH_QUERY_TOO_LONG'
    throw error
  }
  return query
}

/** Read one code point (a surrogate pair stays together). */
function readCodePointAt(text, index) {
  const code = text.charCodeAt(index)
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
    const next = text.charCodeAt(index + 1)
    if (next >= 0xdc00 && next <= 0xdfff) {
      return { ch: text.slice(index, index + 2), width: 2 }
    }
  }
  return { ch: text[index], width: 1 }
}

/**
 * Build NFKC-normalised text plus a `normalizedIndex -> originalIndex` map.
 *
 * Normalisation rules (matching-only; snippets still come from the original):
 *   - NFKC per code point: `ℒ (𝑉)` -> `L (V)`, math italics -> ASCII,
 *     `ﬁ` -> `fi`, full-width letters/digits -> ASCII.
 *   - soft hyphens (U+00AD) are removed;
 *   - every dash (U+002D, U+2010–U+2015, U+2212) is removed.  This makes
 *     matching hyphen-insensitive.  When a dash is followed by whitespace --
 *     which is what a line-break hyphen looks like after extraction -- the
 *     whitespace is removed too, so `com- plex` becomes `complex`.
 *   - whitespace runs collapse to one space; leading/trailing space is
 *     dropped.
 *
 * The map covers every UTF-16 unit of the result, so callers can cut snippets
 * from the original text.
 *
 * @param {string} original already whitespace-collapsed source text
 * @returns {{text: string, map: number[]}}
 */
function buildNormalizedText(original) {
  const chars = []
  const map = []
  let pendingSpaceAt = -1
  let index = 0

  while (index < original.length) {
    const { ch, width } = readCodePointAt(original, index)
    if (ch === SOFT_HYPHEN) {
      index += width
      continue
    }

    // ASCII is NFKC-stable; skip the costlier normalisation call for it.
    const folded = ch.charCodeAt(0) < 0x80 ? ch : ch.normalize('NFKC')

    if (DASH_CHARACTERS.has(folded)) {
      index += width
      // Line-break hyphenation: join the two halves by dropping the
      // whitespace that follows the dash as well.
      while (index < original.length) {
        const next = readCodePointAt(original, index)
        if (!isWhitespace(next.ch)) break
        index += next.width
      }
      continue
    }

    if (isWhitespace(folded)) {
      if (chars.length > 0 && pendingSpaceAt < 0) pendingSpaceAt = index
      index += width
      continue
    }

    if (pendingSpaceAt >= 0) {
      chars.push(' ')
      map.push(pendingSpaceAt)
      pendingSpaceAt = -1
    }
    // A code point may expand (`ﬁ` -> `fi`); every produced unit maps back to
    // the same source code point.
    for (let offset = 0; offset < folded.length; offset += 1) {
      chars.push(folded[offset])
      map.push(index)
    }
    index += width
  }

  return { text: chars.join(''), map }
}

/**
 * Normalise text for matching (NFKC, dash-insensitive, single-spaced).
 * Exported for tests; searchPdf uses the same rules.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeSearchText(raw) {
  const original = String(raw ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
  return buildNormalizedText(original).text
}

/**
 * One page's matching views.  `original` is exactly what getPageText()
 * returns, so `indexOnPage` and snippets use the host-facing text.
 *
 * @typedef {Object} SearchLayout
 * @property {string} original
 * @property {string} normalized
 * @property {number[]} normalizedToOriginal
 * @property {string} compact
 * @property {number[]} compactToNormalized
 * @property {string} normalizedLower
 * @property {number[]} lowerToNormalized
 */

/**
 * @param {string} rawText
 * @returns {SearchLayout}
 */
export function buildSearchLayout(rawText) {
  const original = String(rawText ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
  const { text: normalized, map: normalizedToOriginal } = buildNormalizedText(original)

  const compactChars = []
  const compactToNormalized = []
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index] === ' ') continue
    compactChars.push(normalized[index])
    compactToNormalized.push(index)
  }

  // Case-folded view for the all-terms pass, with its own index map so a
  // snippet can still be traced back to `original`.
  const lowerChars = []
  const lowerToNormalized = []
  for (let index = 0; index < normalized.length; ) {
    const { ch, width } = readCodePointAt(normalized, index)
    const lower = ch.toLowerCase()
    for (let offset = 0; offset < lower.length; offset += 1) {
      lowerChars.push(lower[offset])
      lowerToNormalized.push(index)
    }
    index += width
  }

  return {
    original,
    normalized,
    normalizedToOriginal,
    compact: compactChars.join(''),
    compactToNormalized,
    normalizedLower: lowerChars.join(''),
    lowerToNormalized,
  }
}

/**
 * Prepare both the user-facing (cleaned) query and its matchable form.
 *
 * @param {string} raw
 * @returns {{query: string, needle: string}}
 */
export function prepareSearchQuery(raw) {
  const query = cleanSearchQuery(raw)
  const needle = normalizeSearchText(query)
  if (needle === '') {
    // e.g. a query made only of dashes, which normalisation deletes.
    throw new TypeError('searchPdf: query must be a non-empty string')
  }
  return { query, needle }
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function makeSnippet(text, index, matchLength, contextChars) {
  let start = Math.max(0, index - contextChars)
  let end = Math.min(text.length, index + matchLength + contextChars)
  // Do not cut a surrogate pair in half: a math-italic glyph sits next to
  // almost every hit in a formula-heavy book, and half a pair renders as U+FFFD.
  if (start > 0 && start < text.length) {
    const code = text.charCodeAt(start)
    if (code >= 0xdc00 && code <= 0xdfff && isHighSurrogate(text.charCodeAt(start - 1))) start -= 1
  }
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1)
    if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(end))) end += 1
  }
  let snippet = text.slice(start, end).trim()
  if (start > 0) snippet = `…${snippet}`
  if (end < text.length) snippet = `${snippet}…`
  return snippet
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff
}

/** @param {string} needle @param {boolean} ignoreCase */
function makeSearchPattern(needle, ignoreCase) {
  return new RegExp(escapeRegExp(needle), ignoreCase ? 'giu' : 'gu')
}

/** Yield every match; guards a future zero-length needle against a spin. */
function* iterateMatches(pattern, text) {
  pattern.lastIndex = 0
  let match
  while ((match = pattern.exec(text)) !== null) {
    yield match
    if (match[0].length === 0) pattern.lastIndex += 1
  }
}

/** Map a [start, end) range in `normalized` back to the original text. */
function normalizedRangeToOriginal(layout, startIndex, endIndex) {
  const start = layout.normalizedToOriginal[startIndex] ?? 0
  const end =
    endIndex < layout.normalized.length
      ? layout.normalizedToOriginal[endIndex] ?? layout.original.length
      : layout.original.length
  return { start, length: Math.max(0, end - start) }
}

/** Map a [start, end) range in `compact` back to the original text. */
function compactRangeToOriginal(layout, startIndex, endIndex) {
  const normalizedStart = layout.compactToNormalized[startIndex] ?? 0
  const normalizedEnd =
    endIndex < layout.compact.length
      ? layout.compactToNormalized[endIndex] ?? layout.normalized.length
      : layout.normalized.length
  return normalizedRangeToOriginal(layout, normalizedStart, normalizedEnd)
}

/** Map a [start, end) range in `normalizedLower` back to the original text. */
function lowerRangeToOriginal(layout, startIndex, endIndex) {
  const normalizedStart = layout.lowerToNormalized[startIndex] ?? 0
  const normalizedEnd =
    endIndex < layout.normalizedLower.length
      ? layout.lowerToNormalized[endIndex] ?? layout.normalized.length
      : layout.normalized.length
  return normalizedRangeToOriginal(layout, normalizedStart, normalizedEnd)
}

function makeSearchHit(layout, pdfPage, printed, range, contextChars) {
  return {
    pdf: pdfPage,
    printed,
    indexOnPage: range.start,
    snippet: makeSnippet(layout.original, range.start, range.length, contextChars),
  }
}

/**
 * True when `printed` is a body-page number.  Roman numerals / missing labels
 * (front matter) return false.
 *
 * @param {number|string|null} printed
 * @returns {boolean}
 */
export function isBodyPage(printed) {
  return typeof printed === 'number' && Number.isFinite(printed)
}

/**
 * Body hits first (page/offset order), then up to `frontMatterLimit` front
 * matter hits, filling no more than `limit` slots in total.
 *
 * @param {Array<{pdf:number, printed:number|string|null, indexOnPage?:number}>} hits
 * @param {{limit?: number, frontMatterLimit?: number}} [options]
 * @returns {Array<Object>}
 */
export function rankSearchHits(hits, { limit = 200, frontMatterLimit = MAX_FRONT_MATTER_HITS } = {}) {
  if (!Array.isArray(hits) || hits.length === 0 || limit < 1) return []
  const byPosition = (a, b) =>
    (Number(a.pdf) || 0) - (Number(b.pdf) || 0) ||
    (Number(a.indexOnPage) || 0) - (Number(b.indexOnPage) || 0)
  const body = hits.filter((hit) => isBodyPage(hit.printed)).sort(byPosition)
  const front = hits.filter((hit) => !isBodyPage(hit.printed)).sort(byPosition)
  const selected = body.slice(0, limit)
  const room = Math.max(0, limit - selected.length)
  return [...selected, ...front.slice(0, Math.min(frontMatterLimit, room))]
}

/**
 * Split a normalised query into term-AND tokens.  One-character noise is
 * dropped and at most MAX_TERM_TOKENS words are examined.
 */
function buildSearchTerms(needle, ignoreCase) {
  const tokens = needle
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2)
    .slice(0, MAX_TERM_TOKENS)
  return ignoreCase ? tokens.map((token) => token.toLowerCase()) : tokens
}

/** Earliest position in a page where every term occurs, or null. */
function findTermsSpan(layout, terms, ignoreCase) {
  if (terms.length === 0) return null
  const haystack = ignoreCase ? layout.normalizedLower : layout.normalized
  let span = null
  for (const term of terms) {
    const index = haystack.indexOf(term)
    if (index < 0) return null
    if (span === null || index < span.start) span = { start: index, length: term.length }
  }
  return span
}

/**
 * Collect ranked hits for one matching pass without keeping the whole book in
 * memory.  Pages may be noted even after the hit caps are full, because
 * `pages` must count every matched page.
 */
function createSearchPass(limit, frontMatterLimit = MAX_FRONT_MATTER_HITS) {
  const bodyHits = []
  const frontHits = []
  let pages = 0
  let countedPdfPage = -1

  return {
    get pages() {
      return pages
    },
    notePage(pdfPage) {
      if (countedPdfPage !== pdfPage) {
        countedPdfPage = pdfPage
        pages += 1
      }
    },
    canAdd(printed) {
      return isBodyPage(printed) ? bodyHits.length < limit : frontHits.length < frontMatterLimit
    },
    add(hit, printed) {
      if (isBodyPage(printed)) bodyHits.push(hit)
      else frontHits.push(hit)
    },
    finish() {
      // Body hits were added first; slice applies the overall limit while the
      // front-matter cap above keeps at most three from the tail.
      return { hits: [...bodyHits, ...frontHits].slice(0, limit), pages }
    },
  }
}

function normalizeSearchOptions(options) {
  const opts = options && typeof options === 'object' ? options : {}
  const ignoreCase = opts.ignoreCase !== false

  const limit = opts.limit === undefined ? 200 : opts.limit
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`searchPdf: limit must be a positive integer (got ${String(opts.limit)})`)
  }

  const contextChars = opts.contextChars === undefined ? 80 : opts.contextChars
  if (!Number.isInteger(contextChars) || contextChars < 0) {
    throw new RangeError(
      `searchPdf: contextChars must be a non-negative integer (got ${String(opts.contextChars)})`,
    )
  }

  // Optional 1-based physical page filter. `null` means the whole document.
  let pdfPages = null
  if (opts.pdfPages !== undefined && opts.pdfPages !== null) {
    if (!Array.isArray(opts.pdfPages)) {
      throw new RangeError('searchPdf: pdfPages must be an array of 1-based page numbers')
    }
    const unique = []
    for (const page of opts.pdfPages) {
      if (!Number.isInteger(page) || page < 1) {
        throw new RangeError(
          `searchPdf: pdfPages must contain positive integers (got ${JSON.stringify(page)})`,
        )
      }
      if (!unique.includes(page)) unique.push(page)
    }
    if (unique.length === 0) throw new RangeError('searchPdf: pdfPages must not be empty')
    pdfPages = unique.sort((a, b) => a - b)
  }

  return { ignoreCase, limit, contextChars, pdfPages }
}

/**
 * Whole-document text search, one extraction pass per page.
 *
 * Matching is tried in this order, and the first pass with any hit decides the
 * result (and `mode`):
 *
 *   1. `phrase`  -- literal search over NFKC-normalised page text, with
 *                   wrapping quotes and dashes ignored and case-insensitive by
 *                   default.  Hyphenation is normalised on both sides, so
 *                   `complex` finds a page containing `com- plex`.
 *   2. `compact` -- only when no phrase matched: all spaces are removed from
 *                   both needle and page, so `L(V)` finds `ℒ (𝑉)` and
 *                   `T∈L(V)` finds `𝑆 , 𝑇 ∈ ℒ (𝑉)`.
 *   3. `terms`   -- only when neither matched: every letter/digit token of the
 *                   query must occur somewhere on the page (AND), at most one
 *                   hit per page.
 *
 * Hits are ranked body pages first, then front matter (at most
 * MAX_FRONT_MATTER_HITS front hits).  `pages` counts every matched page in the
 * active pass before ranking/limit.
 *
 * `indexOnPage` is a UTF-16 offset into the same whitespace-normalised text
 * that getPageText() returns (the original, not the normalised search view),
 * and snippets are cut from that original text.
 *
 * @param {string} path
 * @param {string} query
 * @param {{ignoreCase?: boolean, limit?: number, contextChars?: number}} [options]
 * @returns {Promise<{hits: Array<{pdf:number, printed:number|string|null,
 *   indexOnPage:number, snippet:string}>, pages:number,
 *   mode: 'phrase'|'compact'|'terms'}>}
 */
export async function searchPdf(path, query, options) {
  const { needle } = prepareSearchQuery(query)
  const { ignoreCase, limit, contextChars, pdfPages } = normalizeSearchOptions(options)

  const phrasePattern = makeSearchPattern(needle, ignoreCase)
  const compactNeedle = needle.replace(/ /gu, '')
  const compactPattern =
    compactNeedle === '' ? null : makeSearchPattern(compactNeedle, ignoreCase)
  const terms = buildSearchTerms(needle, ignoreCase)

  const phrasePass = createSearchPass(limit)
  const compactPass = createSearchPass(limit)
  const termsPass = createSearchPass(limit)

  return withEntry(path, async (entry) => {
    const meta = await ensureMetadata(entry)
    if (pdfPages !== null) {
      for (const page of pdfPages) {
        if (page > entry.doc.numPages) {
          const error = new RangeError(
            `PDF page must be an integer between 1 and ${entry.doc.numPages} (got ${page})`,
          )
          error.code = 'PDF_PAGE_OUT_OF_RANGE'
          throw error
        }
      }
    }
    const scanCount = pdfPages === null ? entry.doc.numPages : pdfPages.length

    for (let scanIndex = 0; scanIndex < scanCount; scanIndex += 1) {
      const pdfPage = pdfPages === null ? scanIndex + 1 : pdfPages[scanIndex]
      let text
      try {
        text = await extractPageText(entry, pdfPage)
      } catch (error) {
        const wrapped = new Error(
          `searchPdf: failed to extract text from page ${pdfPage} of ${entry.path}: ${
            error?.message || error
          }`,
          { cause: error },
        )
        wrapped.code = 'PDF_TEXT_EXTRACTION_FAILED'
        throw wrapped
      }

      const layout = buildSearchLayout(text)
      const printed = printedForPdf(meta, pdfPage)

      // 1. Phrase (always evaluated; it wins over any fallback).
      let pageMatched = false
      for (const match of iterateMatches(phrasePattern, layout.normalized)) {
        if (!pageMatched) {
          phrasePass.notePage(pdfPage)
          pageMatched = true
        }
        if (!phrasePass.canAdd(printed)) break
        phrasePass.add(
          makeSearchHit(
            layout,
            pdfPage,
            printed,
            normalizedRangeToOriginal(layout, match.index, match.index + match[0].length),
            contextChars,
          ),
          printed,
        )
      }

      // Once any phrase hit exists, the fallbacks can no longer win.  This
      // also keeps the common case to ~one regex pass per page.
      if (phrasePass.pages > 0) continue

      // 2. Compact (space-insensitive).
      if (compactPattern !== null) {
        pageMatched = false
        for (const match of iterateMatches(compactPattern, layout.compact)) {
          if (!pageMatched) {
            compactPass.notePage(pdfPage)
            pageMatched = true
          }
          if (!compactPass.canAdd(printed)) break
          compactPass.add(
            makeSearchHit(
              layout,
              pdfPage,
              printed,
              compactRangeToOriginal(layout, match.index, match.index + match[0].length),
              contextChars,
            ),
            printed,
          )
        }
      }

      if (compactPass.pages > 0) continue

      // 3. All-terms AND fallback.
      const span = findTermsSpan(layout, terms, ignoreCase)
      if (span !== null) {
        termsPass.notePage(pdfPage)
        if (termsPass.canAdd(printed)) {
          const range = ignoreCase
            ? lowerRangeToOriginal(layout, span.start, span.start + span.length)
            : normalizedRangeToOriginal(layout, span.start, span.start + span.length)
          termsPass.add(makeSearchHit(layout, pdfPage, printed, range, contextChars), printed)
        }
      }
    }

    let mode = 'phrase'
    let active = phrasePass.finish()
    if (phrasePass.pages === 0) {
      if (compactPass.pages > 0) {
        mode = 'compact'
        active = compactPass.finish()
      } else if (termsPass.pages > 0) {
        mode = 'terms'
        active = termsPass.finish()
      }
    }

    return { hits: active.hits, pages: active.pages, mode }
  })
}

// ---------------------------------------------------------------------------
// Internal exports for render.js (not part of the host-facing interface)
// ---------------------------------------------------------------------------

export {
  acquire as __acquireDocument,
  releaseEntry as __releaseDocument,
  ensureMetadata as __ensureMetadata,
  normalizePdfPageNumber as __normalizePdfPage,
}
