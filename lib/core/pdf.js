/**
 * dsh-pdf-reader core / pdf.js
 *
 * Pure-Node PDF access for the host half of dsh-pdf-reader:
 *
 *   - a small LRU cache of parsed PDF.js documents (path + mtime + size),
 *   - metadata (page labels, detected printed-page offset, resolved outline),
 *   - whitespace-normalised page text,
 *   - literal full-text search with physical *and* printed page numbers.
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

      const title =
        typeof node.title === 'string' ? node.title.replace(/\s+/g, ' ').trim() : ''
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
    const str = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
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
    return normalizePageText(raw)
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function makeSnippet(text, index, matchLength, contextChars) {
  const start = Math.max(0, index - contextChars)
  const end = Math.min(text.length, index + matchLength + contextChars)
  let snippet = text.slice(start, end).trim()
  if (start > 0) snippet = `…${snippet}`
  if (end < text.length) snippet = `${snippet}…`
  return snippet
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

  return { ignoreCase, limit, contextChars }
}

/**
 * Literal full-text search, one page at a time so the event loop is not
 * blocked for the whole book.  Returns physical and printed page numbers.
 *
 * `indexOnPage` is a UTF-16 offset into the same whitespace-normalised text
 * that getPageText() returns.
 *
 * @param {string} path
 * @param {string} query
 * @param {{ignoreCase?: boolean, limit?: number, contextChars?: number}} [options]
 * @returns {Promise<{hits: Array<{pdf:number, printed:number|string|null,
 *   indexOnPage:number, snippet:string}>, pages:number}>}
 */
export async function searchPdf(path, query, options) {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new TypeError('searchPdf: query must be a non-empty string')
  }

  const needle = normalizePageText(query)
  const { ignoreCase, limit, contextChars } = normalizeSearchOptions(options)
  const pattern = new RegExp(escapeRegExp(needle), ignoreCase ? 'gi' : 'g')

  return withEntry(path, async (entry) => {
    const meta = await ensureMetadata(entry)
    const hits = []
    let pages = 0

    for (let pdfPage = 1; pdfPage <= entry.doc.numPages; pdfPage += 1) {
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

      pattern.lastIndex = 0
      let match
      let pageCounted = false
      while ((match = pattern.exec(text)) !== null) {
        if (!pageCounted) {
          pages += 1
          pageCounted = true
        }
        if (hits.length < limit) {
          hits.push({
            pdf: pdfPage,
            printed: printedForPdf(meta, pdfPage),
            indexOnPage: match.index,
            snippet: makeSnippet(text, match.index, match[0].length, contextChars),
          })
        }
        // A zero-length match is impossible (needle is non-empty), but guard
        // anyway so a future change cannot spin forever.
        if (match[0].length === 0) pattern.lastIndex += 1
      }
    }

    return { hits, pages }
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
