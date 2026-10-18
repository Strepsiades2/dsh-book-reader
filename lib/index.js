/**
 * Host half of dsh-pdf-reader.
 *
 * Registers four model-callable PDF tools, the browser-facing HTTP routes, and
 * one `agent/pre-step` injection that tells the model which page the user is
 * looking at. The PDF engine itself lives in `lib/core/` and is imported
 * lazily, so this module can be loaded (and its pure helpers tested) even
 * while that engine is absent.
 *
 * Design constraints:
 * - Route validation mirrors `dsh-pdf-search`: loopback Host, absolute path,
 *   `.pdf` suffix, regular file, size cap, JSON only, no CORS header.
 * - Page images use the same attachment route as `read_image`: a durable
 *   `attachments.saveImage` reference plus an `ImageBlock` from `render()`.
 * - Auto-share is per-session and deliberately conservative: a changed page,
 *   a minimum interval, a minimum step distance, at most one message per step.
 *
 * @module dsh-pdf-reader
 */

import { basename, isAbsolute, resolve as resolvePath } from 'node:path'
import { appendFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'pdf-reader'

/** Host services this plugin answers from and hooks into. */
export const inject = ['tools', 'webServer', 'agents']

/** Prefix route owned by this plugin; every sub-route is matched exactly. */
export const ROUTE_PATH = '/dsh-pdf-reader'

/** Largest PDF this plugin will open, in bytes. */
const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024

/** Hard safety ceiling on a request body accepted by POST /current. */
const DEFAULT_MAX_ROUTE_BODY_BYTES = 64 * 1024

/** Hard ceiling for one `pdf_read_pages` call, regardless of configuration. */
export const ABSOLUTE_MAX_PAGES_PER_CALL = 8

/** Ceiling used while expanding a page selection, so `1-100000` fails fast. */
const PAGE_SELECTION_HARD_LIMIT = 256

/** Config schema. Every key is optional in YAML; defaults live here. */
export const Config = z.object({
  /** Master switch: false mounts no tool, route, or listener. */
  enabled: z.boolean().default(true),
  /** Inject the current reading page into `agent/pre-step`. */
  autoShare: z.boolean().default(true),
  /** Resolve the outline section for the injected message (one cached getInfo). */
  autoShareSection: z.boolean().default(true),
  /** Minimum milliseconds between two injected reading positions. */
  autoShareMinIntervalMs: z.number().default(180_000),
  /** Minimum absolute page change required before another injection. */
  autoSharePageDelta: z.number().default(1),
  /** Minimum step distance between injections in the same turn. */
  autoShareMinSteps: z.number().default(1),
  /** Ignore a reported position older than this; 0 means no age limit. */
  autoShareMaxAgeMs: z.number().default(0),
  /** Hard cap on pages rendered by one `pdf_read_pages` call. */
  maxPagesPerCall: z.number().default(4),
  /** Default render scale for `pdf_read_pages` (2.5 is ~180 DPI). */
  defaultScale: z.number().default(2.5),
  /** Characters of extracted text kept per page; 0 disables text. */
  maxTextCharsPerPage: z.number().default(1200),
  /** Maximum search hits returned by the tool and the route. */
  maxSearchResults: z.number().default(100),
  /** Maximum outline entries returned by the route. */
  maxOutlineEntries: z.number().default(500),
  /** Maximum page labels included by `pdf_info`. */
  maxLabels: z.number().default(80),
  /** Largest PDF this plugin will stat, parse, or render. */
  maxFileBytes: z.number().default(DEFAULT_MAX_FILE_BYTES),
  /** Largest JSON body accepted by POST /current. */
  maxRouteBodyBytes: z.number().default(DEFAULT_MAX_ROUTE_BODY_BYTES),
  /** Parsed `getInfo` results kept per process (path + mtime + size). */
  infoCacheSize: z.number().default(8),
})

/** Defaults applied independently of the loader, so direct callers work too. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  autoShare: true,
  autoShareSection: true,
  autoShareMinIntervalMs: 180_000,
  autoSharePageDelta: 1,
  autoShareMinSteps: 1,
  autoShareMaxAgeMs: 0,
  maxPagesPerCall: 4,
  defaultScale: 2.5,
  maxTextCharsPerPage: 1200,
  maxSearchResults: 100,
  maxOutlineEntries: 500,
  maxLabels: 80,
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  maxRouteBodyBytes: DEFAULT_MAX_ROUTE_BODY_BYTES,
  infoCacheSize: 8,
})

/** Shape of the per-session auto-share bookkeeping. */
export const INITIAL_AUTO_SHARE_STATE = Object.freeze({
  lastInjectedPath: null,
  lastInjectedPdfPage: null,
  lastInjectedAt: null,
  lastInjectedTurn: null,
  lastInjectedStep: null,
})

/** Create an Error carrying a stable code, for tests and route mapping. */
function codedError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Read a boolean config value with a clear failure. */
function configBoolean(value, fallback, key) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`pdf-reader: ${key} must be a boolean`)
  return value
}

/** Read an integer config value within an inclusive range. */
function configInteger(value, fallback, key, min, max) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`pdf-reader: ${key} must be an integer between ${min} and ${max}, got ${String(value)}`)
  }
  return value
}

/** Read a numeric config value within an inclusive range. */
function configNumber(value, fallback, key, min, max) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`pdf-reader: ${key} must be a number between ${min} and ${max}, got ${String(value)}`)
  }
  return value
}

/**
 * Apply defaults and range-check one raw plugin config.
 * @param raw - the loader-validated config, a partial object, or undefined.
 * @returns a complete config object.
 * @throws TypeError on a value the plugin cannot honor.
 */
export function normalizeConfig(raw) {
  const source = raw ?? {}
  if (typeof source !== 'object' || Array.isArray(source)) throw new TypeError('pdf-reader: config must be an object')
  return {
    enabled: configBoolean(source.enabled, DEFAULT_CONFIG.enabled, 'enabled'),
    autoShare: configBoolean(source.autoShare, DEFAULT_CONFIG.autoShare, 'autoShare'),
    autoShareSection: configBoolean(source.autoShareSection, DEFAULT_CONFIG.autoShareSection, 'autoShareSection'),
    autoShareMinIntervalMs: configInteger(
      source.autoShareMinIntervalMs,
      DEFAULT_CONFIG.autoShareMinIntervalMs,
      'autoShareMinIntervalMs',
      0,
      86_400_000,
    ),
    autoSharePageDelta: configInteger(source.autoSharePageDelta, DEFAULT_CONFIG.autoSharePageDelta, 'autoSharePageDelta', 1, 1000),
    autoShareMinSteps: configInteger(source.autoShareMinSteps, DEFAULT_CONFIG.autoShareMinSteps, 'autoShareMinSteps', 1, 1000),
    autoShareMaxAgeMs: configInteger(source.autoShareMaxAgeMs, DEFAULT_CONFIG.autoShareMaxAgeMs, 'autoShareMaxAgeMs', 0, 31_536_000_000),
    maxPagesPerCall: configInteger(
      source.maxPagesPerCall,
      DEFAULT_CONFIG.maxPagesPerCall,
      'maxPagesPerCall',
      1,
      ABSOLUTE_MAX_PAGES_PER_CALL,
    ),
    defaultScale: configNumber(source.defaultScale, DEFAULT_CONFIG.defaultScale, 'defaultScale', 1, 3),
    maxTextCharsPerPage: configInteger(
      source.maxTextCharsPerPage,
      DEFAULT_CONFIG.maxTextCharsPerPage,
      'maxTextCharsPerPage',
      0,
      100_000,
    ),
    maxSearchResults: configInteger(source.maxSearchResults, DEFAULT_CONFIG.maxSearchResults, 'maxSearchResults', 1, 500),
    maxOutlineEntries: configInteger(source.maxOutlineEntries, DEFAULT_CONFIG.maxOutlineEntries, 'maxOutlineEntries', 1, 5000),
    maxLabels: configInteger(source.maxLabels, DEFAULT_CONFIG.maxLabels, 'maxLabels', 0, 1000),
    maxFileBytes: configInteger(source.maxFileBytes, DEFAULT_CONFIG.maxFileBytes, 'maxFileBytes', 1, 8 * 1024 * 1024 * 1024),
    maxRouteBodyBytes: configInteger(
      source.maxRouteBodyBytes,
      DEFAULT_CONFIG.maxRouteBodyBytes,
      'maxRouteBodyBytes',
      1024,
      4 * 1024 * 1024,
    ),
    infoCacheSize: configInteger(source.infoCacheSize, DEFAULT_CONFIG.infoCacheSize, 'infoCacheSize', 1, 64),
  }
}

/**
 * Whether a request's Host header names the loopback interface.
 *
 * The route serves the local application only, and the webserver itself carries
 * no authentication, so a request addressed to another name is refused.
 * @param host - the raw Host header.
 * @returns true for `127.0.0.1`, `localhost`, and `::1`, with any port.
 */
export function loopbackHost(host) {
  if (typeof host !== 'string' || host === '') return false
  let raw
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    if (end < 0) return false
    raw = host.slice(1, end)
  } else if (host === '::1') {
    // Tolerate an unbracketed bare IPv6 loopback; a bracketed form is the
    // RFC-correct Host header and is handled above.
    raw = host
  } else {
    raw = host.split(':')[0]
  }
  const hostname = raw.toLowerCase()
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

/** Answer one request with JSON and no CORS header. */
function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(text)
}

/** One HTTP failure with the status and stable error token the route returns. */
function httpError(status, error, message = error) {
  const failure = new Error(message)
  failure.status = status
  failure.error = error
  return failure
}

/**
 * Validate a route target exactly like `dsh-pdf-search` does.
 * @param rawPath - the raw `path` query/body value.
 * @param options - file-stat function and size cap.
 * @returns `{ ok: true, path, stat }` or `{ ok: false, status, error }`.
 */
export async function validateRouteTarget(rawPath, { statFile = stat, maxFileBytes = DEFAULT_CONFIG.maxFileBytes } = {}) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { ok: false, status: 400, error: 'invalid-path' }
  }
  if (!isAbsolute(rawPath)) return { ok: false, status: 400, error: 'invalid-path' }
  const path = resolvePath(rawPath)
  if (!/\.pdf$/iu.test(path)) return { ok: false, status: 400, error: 'invalid-path' }
  let info
  try {
    info = await statFile(path)
  } catch {
    return { ok: false, status: 404, error: 'missing' }
  }
  if (typeof info?.isFile !== 'function' || !info.isFile()) {
    return { ok: false, status: 400, error: 'not-a-file' }
  }
  if (typeof info.size !== 'number' || info.size > maxFileBytes) {
    return { ok: false, status: 413, error: 'file-too-large' }
  }
  return { ok: true, path, stat: info }
}

/** Read a bounded JSON request body. */
async function readJsonBody(request, limit) {
  if (typeof request?.[Symbol.asyncIterator] !== 'function') throw httpError(400, 'invalid-body')
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    bytes += buffer.byteLength
    if (bytes > limit) throw httpError(413, 'body-too-large')
    chunks.push(buffer)
  }
  if (bytes === 0) throw httpError(400, 'invalid-json', 'empty request body')
  let value
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw httpError(400, 'invalid-json')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, 'invalid-json', 'request body must be a JSON object')
  }
  return value
}

/**
 * Cache `getInfo` by path, mtime, and size. Both the routes and the tools use
 * one instance so a page change never re-parses the outline for every caller.
 * @param options - `getInfo` loader, stat function, and LRU bound.
 */
export function createInfoCache({ getInfo, statFile = stat, limit = DEFAULT_CONFIG.infoCacheSize } = {}) {
  if (typeof getInfo !== 'function') throw new TypeError('createInfoCache: getInfo must be a function')
  const entries = new Map()

  async function load(path, knownStat) {
    const info = knownStat ?? (await statFile(path))
    const key = `${path}\u0000${String(info.mtimeMs ?? '')}\u0000${String(info.size ?? '')}`
    const cached = entries.get(key)
    if (cached !== undefined) {
      entries.delete(key)
      entries.set(key, cached)
      return cached
    }
    const value = await getInfo(path)
    if (value === null || typeof value !== 'object') {
      throw new Error(`pdf-reader: getInfo returned no info for "${path}"`)
    }
    const entry = { info: value, stat: info }
    entries.set(key, entry)
    while (entries.size > limit) {
      const oldest = entries.keys().next()
      if (oldest.done === true) break
      entries.delete(oldest.value)
    }
    return entry
  }

  return {
    load,
    clear() {
      entries.clear()
    },
    get size() {
      return entries.size
    },
  }
}

/**
 * In-memory reading positions: one per session and one latest per path.
 * Sessions are the only source used for auto-share; path positions exist for
 * the un-scoped GET /current form and for diagnostics.
 * @param options - clock and LRU bounds.
 */
export function createPositionStore({ now = Date.now, maxSessions = 200, maxPaths = 100 } = {}) {
  const sessions = new Map()
  const paths = new Map()

  function touch(map, key, value, limit) {
    map.delete(key)
    map.set(key, value)
    while (map.size > limit) {
      const oldest = map.keys().next()
      if (oldest.done === true) break
      map.delete(oldest.value)
    }
  }

  return {
    record({ path, pdfPage, printedPage = null, sessionId = null, printedOffset = null }) {
      const position = {
        path,
        pdfPage,
        printedPage,
        printedOffset,
        sessionId: typeof sessionId === 'string' ? sessionId : null,
        updatedAt: now(),
      }
      if (position.sessionId !== null) touch(sessions, position.sessionId, position, maxSessions)
      touch(paths, path, position, maxPaths)
      return position
    },
    forSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      return sessions.get(sessionId)
    },
    forPath(path) {
      return paths.get(path)
    },
    clear() {
      sessions.clear()
      paths.clear()
    },
    get sessionCount() {
      return sessions.size
    },
    get pathCount() {
      return paths.size
    },
  }
}

/** Normalize unicode dashes so a pasted page range parses. */
function normalizeDashes(value) {
  return value.replace(/[\u2010-\u2015\u2212]/gu, '-')
}

/**
 * Parse `"132-134"`, `"132,135"`, `[132,133,134]`, or `"132-134,137"`.
 * Results are deduplicated and ascending.
 * @param input - the raw `pages` argument.
 * @param options - maximum accepted pages and an expansion guard.
 * @returns ascending, deduplicated page numbers as supplied.
 * @throws Error with code PDF_READER_TOO_MANY_PAGES when the cap is exceeded.
 */
export function parsePageSelection(input, { maxPages = DEFAULT_CONFIG.maxPagesPerCall, hardLimit = PAGE_SELECTION_HARD_LIMIT } = {}) {
  const expanded = []
  let overflow = false

  function pushPage(page) {
    if (expanded.length >= hardLimit) {
      overflow = true
      return
    }
    expanded.push(page)
  }

  function addToken(token) {
    if (typeof token === 'number') {
      if (!Number.isInteger(token) || token < 1 || token > 1_000_000) {
        throw codedError(`page numbers must be positive integers, got ${String(token)}`, 'PDF_READER_INVALID_PAGE')
      }
      pushPage(token)
      return
    }
    if (typeof token !== 'string') {
      throw codedError(`page selections must be strings or integers, got ${typeof token}`, 'PDF_READER_INVALID_PAGE')
    }
    const text = normalizeDashes(token).trim()
    if (text === '') return
    const range = /^(\d+)\s*-\s*(\d+)$/u.exec(text)
    if (range !== null) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (start < 1 || end < 1 || start > 1_000_000 || end > 1_000_000) {
        throw codedError(`page numbers must be positive integers, got "${text}"`, 'PDF_READER_INVALID_PAGE')
      }
      if (start > end) {
        throw codedError(`page range "${text}" starts after it ends`, 'PDF_READER_INVALID_PAGE')
      }
      if (end - start + 1 > hardLimit) {
        throw codedError(`page range "${text}" is too large to expand safely`, 'PDF_READER_TOO_MANY_PAGES')
      }
      for (let page = start; page <= end; page += 1) pushPage(page)
      return
    }
    if (/^\d+$/u.test(text)) {
      const page = Number(text)
      if (page < 1 || page > 1_000_000) {
        throw codedError(`page numbers must be positive integers, got "${text}"`, 'PDF_READER_INVALID_PAGE')
      }
      pushPage(page)
      return
    }
    throw codedError(`cannot parse page selection "${text}"`, 'PDF_READER_INVALID_PAGE')
  }

  if (Array.isArray(input)) {
    for (const item of input) addToken(item)
  } else if (typeof input === 'string') {
    for (const token of input.split(',')) addToken(token)
  } else {
    addToken(input)
  }

  if (overflow) {
    throw codedError(`page selection expands past ${hardLimit} pages`, 'PDF_READER_TOO_MANY_PAGES')
  }
  if (expanded.length === 0) {
    throw codedError('pages must contain at least one page number', 'PDF_READER_INVALID_PAGE')
  }
  const unique = [...new Set(expanded)].sort((a, b) => a - b)
  if (unique.length > maxPages) {
    throw codedError(
      `requested ${unique.length} pages, but one call may read at most ${maxPages}; split the request into smaller calls`,
      'PDF_READER_TOO_MANY_PAGES',
    )
  }
  return unique
}

/**
 * Parse a crop rectangle: four fractions with a top-left origin.
 * @param input - `"0,0,1,0.55"`, `[0,0,1,0.55]`, `{x,y,w,h}`, or undefined.
 * @returns `{ x, y, w, h }` fractions, or undefined when no crop was requested.
 */
export function parseCrop(input) {
  if (input === undefined || input === null) return undefined

  // The skill documents the core's native shape, {x,y,w,h}; accept it directly.
  if (typeof input === 'object' && !Array.isArray(input)) {
    const { x, y, w, h } = input
    const numbers = [x, y, w, h]
    if (numbers.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw codedError('crop object must contain finite numeric x, y, w, and h', 'PDF_READER_INVALID_CROP')
    }
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1 || y + h > 1) {
      throw codedError(
        'crop must satisfy x,y >= 0, w,h > 0, x+w <= 1, and y+h <= 1',
        'PDF_READER_INVALID_CROP',
      )
    }
    return { x, y, w, h }
  }

  let values
  if (Array.isArray(input)) {
    values = input
  } else if (typeof input === 'string') {
    values = input.split(',').map((part) => part.trim())
  } else {
    throw codedError(
      'crop must be "x0,y0,x1,y1", [x0,y0,x1,y1], or {x,y,w,h}',
      'PDF_READER_INVALID_CROP',
    )
  }
  if (values.length !== 4) {
    throw codedError('crop must contain exactly four values', 'PDF_READER_INVALID_CROP')
  }
  const numbers = values.map((value) => (typeof value === 'number' ? value : Number(value)))
  if (numbers.some((value) => !Number.isFinite(value))) {
    throw codedError('crop values must be finite numbers', 'PDF_READER_INVALID_CROP')
  }
  const [x0, y0, x1, y1] = numbers
  if (x0 < 0 || y0 < 0 || x1 > 1 || y1 > 1 || x0 >= x1 || y0 >= y1) {
    throw codedError('crop must satisfy 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1', 'PDF_READER_INVALID_CROP')
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * Decide whether a PDF exposes numeric printed page numbers.
 * @param info - a `getInfo` result.
 * @returns whether printed numbers are usable and the PDF→printed offset.
 */
export function detectPageMode(info) {
  const labels = Array.isArray(info?.labels) ? info.labels : []
  const hasNumericLabel = labels.some((label) => typeof label?.printed === 'number' && Number.isFinite(label.printed))
  const offset = Number.isInteger(info?.printedOffset) ? info.printedOffset : 0
  return { detectable: hasNumericLabel || offset !== 0, offset }
}

/**
 * Resolve the printed label for one physical page.
 *
 * Prefers the browser-reported label, then the page-label map (which covers
 * roman front matter), then `pdfPage - offset` when the offset is meaningful.
 * Never returns a non-positive body-page number.
 *
 * @param info - a `getInfo` result, or null when metadata is unavailable.
 * @param pdfPage - the 1-based physical page.
 * @param reported - optional label reported by the browser.
 * @returns a number, a label string, or null when no printed page is known.
 */
export function printedPageFor(info, pdfPage, reported = null) {
  if (reported !== null && reported !== undefined && reported !== '') return reported
  const labels = Array.isArray(info?.labels) ? info.labels : []
  const label = labels.find((entry) => Number(entry?.pdf) === pdfPage)
  if (label !== undefined && label.printed !== null && label.printed !== undefined) return label.printed
  const detected = detectPageMode(info)
  if (detected.detectable) {
    const printable = pdfPage - detected.offset
    if (printable >= 1) return printable
  }
  return null
}

/**
 * Resolve a page selection to physical PDF pages.
 * @param options - selection, explicit mode, `getInfo` result, and page cap.
 * @returns physical pages, the resolved mode, and the offset used.
 */
export function resolveRequestedPages({ selection, pageNumbers, info, maxPages = DEFAULT_CONFIG.maxPagesPerCall }) {
  const requested = parsePageSelection(selection, { maxPages })
  const detected = detectPageMode(info)
  const mode = pageNumbers ?? (detected.detectable ? 'printed' : 'pdf')
  if (mode !== 'printed' && mode !== 'pdf') {
    throw codedError(`page_numbers must be "printed" or "pdf", got ${JSON.stringify(mode)}`, 'PDF_READER_INVALID_PAGE_MODE')
  }
  if (mode === 'printed' && !detected.detectable) {
    throw codedError(
      'this PDF has no numeric printed-page labels; pass page_numbers:"pdf" or use physical PDF page numbers',
      'PDF_READER_NO_PRINTED_PAGES',
    )
  }
  const pageCount = Number.isInteger(info?.pageCount) && info.pageCount > 0 ? info.pageCount : null
  const pdfPages = requested.map((page) => (mode === 'printed' ? page + detected.offset : page))
  for (let index = 0; index < pdfPages.length; index += 1) {
    const pdf = pdfPages[index]
    if (pdf < 1) {
      throw codedError(
        `printed page ${requested[index]} maps to PDF page ${pdf}, before the first page (offset ${detected.offset})`,
        'PDF_READER_INVALID_PAGE',
      )
    }
    if (pageCount !== null && pdf > pageCount) {
      const context = mode === 'printed' ? ` (printed page ${requested[index]}, offset ${detected.offset})` : ''
      throw codedError(`PDF page ${pdf} is outside this document (${pageCount} pages)${context}`, 'PDF_READER_INVALID_PAGE')
    }
  }
  return { requested, pdfPages, mode, printedOffset: detected.detectable ? detected.offset : 0 }
}

/** Coerce page labels to the JSON shape the output schemas allow. */
function sanitizeLabels(labels, limit) {
  if (!Array.isArray(labels)) return undefined
  return labels.slice(0, limit).map((label) => ({
    pdf: Number(label?.pdf),
    printed: label?.printed ?? null,
  }))
}

/** Coerce an outline entry to the JSON shape this plugin exposes. */
function outlineEntry(entry) {
  return {
    title: String(entry?.title ?? ''),
    pdf: Number(entry?.pdf),
    printed: entry?.printed ?? null,
    depth: Number.isInteger(entry?.depth) ? entry.depth : 0,
  }
}

/**
 * Keep the first `limit` outline entries.
 * @returns `{ outline, truncated }`.
 */
export function sanitizeOutline(outline, limit = DEFAULT_CONFIG.maxOutlineEntries) {
  if (!Array.isArray(outline)) return { outline: [], truncated: false }
  const entries = outline
    .filter((entry) => entry !== null && typeof entry === 'object' && Number.isFinite(Number(entry.pdf)))
    .slice(0, limit)
    .map(outlineEntry)
  return { outline: entries, truncated: outline.length > entries.length }
}

/**
 * Find the ancestor chain of outline entries containing one PDF page.
 * Entries must be in document order, as `getInfo` returns them.
 * @param outline - outline entries with `pdf` and `depth`.
 * @param pdfPage - the physical page to locate.
 * @param options - maximum chain length.
 * @returns ancestors from chapter to the deepest section; empty before the first entry.
 */
export function sectionTrailForPage(outline, pdfPage, { maxDepth = 6 } = {}) {
  if (!Array.isArray(outline) || !Number.isFinite(pdfPage)) return []
  const eligible = outline.filter((entry) => entry !== null && typeof entry === 'object' && Number.isFinite(entry.pdf) && entry.pdf <= pdfPage)
  if (eligible.length === 0) return []
  const chain = []
  let depth = Number.POSITIVE_INFINITY
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    const entry = eligible[index]
    const entryDepth = Number.isInteger(entry.depth) ? entry.depth : 0
    if (entryDepth < depth) {
      chain.unshift(outlineEntry(entry))
      depth = entryDepth
      if (chain.length >= maxDepth) break
    }
  }
  return chain
}

/** Book title used in prose: the PDF basename without its extension. */
export function titleFromPath(path) {
  return basename(String(path)).replace(/\.pdf$/iu, '')
}

/**
 * Render the auto-share message. Source attribution is part of the text and
 * the message source, so compaction and replay can recognize it.
 * @param options - position, title, section chain, and page-number mode.
 * @returns one short user-role message body.
 */
export function renderReadingContext({
  path,
  pdfPage,
  printedPage = null,
  title,
  sectionTrail = [],
  printedOffset = 0,
  mode,
}) {
  const book = title ?? titleFromPath(path)
  const hasPrinted = printedPage !== null && printedPage !== undefined && printedPage !== ''
  const printable = hasPrinted ? printedPage : null
  const resolvedMode = mode ?? (printable === null ? 'pdf' : 'printed')
  const trail = sectionTrail
    .map((entry) => (typeof entry === 'string' ? entry : entry?.title))
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
  const sectionText = trail.join(' \u203a ')
  const head =
    printable === null
      ? `[dsh-pdf-reader] The user is reading "${book}" at PDF page ${pdfPage}${sectionText === '' ? '' : ` \u2014 ${sectionText}`}.`
      : `[dsh-pdf-reader] The user is reading "${book}" at printed page ${printable} (PDF ${pdfPage})${sectionText === '' ? '' : ` \u2014 ${sectionText}`}.`
  // A roman front-matter label is useful in prose but cannot be passed to
  // pdf_read_pages, whose parser only accepts numbers. Use the PDF page for
  // the call hint while still showing the printed label in the first line.
  const numericPrinted = typeof printable === 'number' ? printable : null
  const usePrinted = resolvedMode === 'printed' && numericPrinted !== null
  const target = usePrinted ? numericPrinted : pdfPage
  const hint = usePrinted
    ? `If they say "this page"/"\u5f53\u524d\u9875", call pdf_read_pages with path:${JSON.stringify(path)} and pages:"${target}".`
    : `If they say "this page"/"\u5f53\u524d\u9875", call pdf_read_pages with path:${JSON.stringify(path)}, pages:"${target}", page_numbers:"pdf".`
  return `${head}\n${hint}`
}

/** Whether two injection state records refer to the same page. */
function sameInjectedPage(state, position) {
  return state.lastInjectedPath === position.path && state.lastInjectedPdfPage === position.pdfPage
}

/**
 * Decide whether this step should receive a reading-position message.
 * Pure: callers own the state map and the clock.
 * @param options - position, prior state, turn/step, clock, and config.
 * @returns `{ inject, reason, nextState }`; `nextState` is unchanged when false.
 */
export function decideAutoShare({ position, state = INITIAL_AUTO_SHARE_STATE, now, turn, step, config = DEFAULT_CONFIG }) {
  const keep = { inject: false, reason: '', nextState: state }
  if (!config.autoShare) return { ...keep, reason: 'disabled' }
  if (position === null || position === undefined) return { ...keep, reason: 'no-position' }
  if (sameInjectedPage(state, position)) return { ...keep, reason: 'unchanged' }
  if (config.autoShareMaxAgeMs > 0) {
    if (typeof position.updatedAt !== 'number') return { ...keep, reason: 'unknown-age' }
    if (now - position.updatedAt > config.autoShareMaxAgeMs) return { ...keep, reason: 'stale' }
  }
  if (state.lastInjectedAt !== null && state.lastInjectedAt !== undefined) {
    const elapsed = now - state.lastInjectedAt
    if (!(elapsed >= config.autoShareMinIntervalMs)) return { ...keep, reason: 'throttled' }
  }
  const sameTurn = Number.isInteger(turn) && Number.isInteger(step) && state.lastInjectedTurn === turn
  if (sameTurn && state.lastInjectedStep === step) return { ...keep, reason: 'same-step' }
  if (sameTurn && state.lastInjectedStep !== null && step - state.lastInjectedStep < config.autoShareMinSteps) {
    return { ...keep, reason: 'too-few-steps' }
  }
  if (
    config.autoSharePageDelta > 1 &&
    state.lastInjectedPdfPage !== null &&
    state.lastInjectedPath === position.path &&
    Math.abs(position.pdfPage - state.lastInjectedPdfPage) < config.autoSharePageDelta
  ) {
    return { ...keep, reason: 'page-delta' }
  }
  return {
    inject: true,
    reason: 'due',
    nextState: {
      lastInjectedPath: position.path,
      lastInjectedPdfPage: position.pdfPage,
      lastInjectedAt: now,
      lastInjectedTurn: Number.isInteger(turn) ? turn : null,
      lastInjectedStep: Number.isInteger(step) ? step : null,
    },
  }
}

/**
 * Build the `agent/pre-step` listener. It delegates first, appends at most one
 * source-attributed user message, and records state only after appending.
 * @param options - config, position store, optional info cache, clock, message factory.
 * @returns a Cordis waterfall listener for `agent/pre-step`.
 */
export function createAutoShareListener({
  config,
  positions,
  infoCache = null,
  now = Date.now,
  createMessage = createUserMessage,
  maxStates = 500,
}) {
  const states = new Map()

  function remember(sessionId, state) {
    states.delete(sessionId)
    states.set(sessionId, state)
    while (states.size > maxStates) {
      const oldest = states.keys().next()
      if (oldest.done === true) break
      states.delete(oldest.value)
    }
  }

  return async function pdfReaderPreStep(payload, next) {
    const decision = await next()
    if (!config.autoShare) return decision
    if (decision === null || typeof decision !== 'object' || decision.kind === 'reject') return decision
    if (payload?.signal?.aborted === true) return decision
    const sessionId = payload?.agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return decision
    const position = positions.forSession(sessionId)
    if (position === undefined) return decision
    const state = states.get(sessionId) ?? INITIAL_AUTO_SHARE_STATE
    const verdict = decideAutoShare({
      position,
      state,
      now: now(),
      turn: payload.turn,
      step: payload.step,
      config,
    })
    if (!verdict.inject) return decision

    let trail = []
    let info = null
    if (config.autoShareSection && infoCache !== null) {
      try {
        info = (await infoCache.load(position.path)).info
        trail = sectionTrailForPage(info.outline, position.pdfPage)
      } catch {
        trail = []
      }
    }
    const detected = detectPageMode(info)
    const printable = printedPageFor(info, position.pdfPage, position.printedPage)
    const mode = typeof printable === 'number' ? 'printed' : 'pdf'
    const text = renderReadingContext({
      path: position.path,
      pdfPage: position.pdfPage,
      printedPage: printable,
      title: titleFromPath(position.path),
      sectionTrail: trail,
      printedOffset: detected.offset,
      mode,
    })
    const message = createMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: name,
        form: 'snapshot',
        sections: [{ name, text }],
      },
    })
    remember(sessionId, verdict.nextState)
    const priorMessages = Array.isArray(decision.messages) ? decision.messages : []
    return { ...decision, messages: [...priorMessages, message] }
  }
}

/** Normalize a printed page supplied by the browser: number or short label. */
export function normalizePrintedPage(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 1_000_000) {
      throw codedError('printedPage must be a non-negative integer', 'PDF_READER_INVALID_PRINTED_PAGE')
    }
    return value
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') return null
    if (text.length > 24 || /[\u0000-\u001f\u007f]/u.test(text)) {
      throw codedError('printedPage is not a usable page label', 'PDF_READER_INVALID_PRINTED_PAGE')
    }
    if (/^\d+$/u.test(text)) return Number(text)
    return text
  }
  throw codedError('printedPage must be a number or a page label string', 'PDF_READER_INVALID_PRINTED_PAGE')
}

/** Resolve a model-supplied path against the session cwd. */
export function resolveToolPath(rawPath, exec) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw codedError('path must be a non-empty string', 'PDF_READER_INVALID_PATH')
  }
  if (isAbsolute(rawPath)) return resolvePath(rawPath)
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && isAbsolute(cwd)) return resolvePath(cwd, rawPath)
  throw codedError(`path must be absolute, got "${rawPath}"`, 'PDF_READER_INVALID_PATH')
}

/** TEMP stage logger for live debugging (remove after the bug is fixed). */
function __diag(stage, detail) {
  try {
    appendFileSync('/Users/zyl/my_projects/learn /math/dsh-pdf-reader/.debug.log',
      new Date().toISOString() + ' ' + stage + ' ' + (detail === undefined ? '' : detail) + '\n')
  } catch {}
}

/** Stat and validate a tool target, with model-facing failures. */
export async function assertPdfFile(path, { statFile = stat, maxFileBytes = DEFAULT_CONFIG.maxFileBytes } = {}) {
  if (!/\.pdf$/iu.test(path)) throw codedError(`cannot read "${path}": not a .pdf file`, 'PDF_NOT_FILE')
  let info
  try {
    info = await statFile(path)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw codedError(`cannot read "${path}": not found`, 'PDF_NOT_FOUND')
    }
    throw codedError(`cannot read "${path}": ${error instanceof Error ? error.message : String(error)}`, 'PDF_UNREADABLE')
  }
  if (typeof info?.isFile !== 'function' || !info.isFile()) {
    throw codedError(`cannot read "${path}": not a regular file`, 'PDF_NOT_FILE')
  }
  if (typeof info.size !== 'number' || info.size > maxFileBytes) {
    throw codedError(`cannot read "${path}": file is larger than the ${maxFileBytes}-byte limit`, 'PDF_READER_FILE_TOO_LARGE')
  }
  return info
}

/** Re-brand a structured image outcome into an `ImageBlock` attachment. */
export function imageRefFromValue(image) {
  return {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name === undefined ? {} : { name: image.name }),
    ...(image.originalDimensions === undefined ? {} : { originalDimensions: { ...image.originalDimensions } }),
  }
}

/** Escape text placed inside the small XML-ish envelopes in tool content. */
function escapeEnvelope(text) {
  return String(text).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
  },
}

const PRINTED_PAGE_SCHEMA = {
  oneOf: [{ type: 'integer' }, { type: 'string' }, { type: 'null' }],
}

const SECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', required: true },
    pdf: { type: 'integer', required: true },
    printed: { ...PRINTED_PAGE_SCHEMA },
    depth: { type: 'integer', required: true },
  },
}

/** Render one `pdf_read_pages` outcome as text envelopes plus image blocks. */
export function renderPageReadContent(value) {
  const summary = value.pages
    .map((page) => `PDF ${page.pdf}${page.printed === page.pdf ? '' : ` / printed ${page.printed}`}`)
    .join(', ')
  const blocks = [
    {
      type: 'text',
      text: `<path>${escapeEnvelope(value.path)}</path>\n<book>${escapeEnvelope(value.book)}</book>\n<pages mode="${value.pageNumbers}" printed-offset="${value.printedOffset}">${summary}</pages>`,
    },
  ]
  for (const page of value.pages) {
    const body =
      page.text !== undefined
        ? page.text
        : page.textUnavailable === true
          ? '(no text layer on this page; read the image)'
          : '(text not requested; read the image)'
    const truncation = page.textTruncated === true ? '\n(text truncated)' : ''
    blocks.push({
      type: 'text',
      text: `<page pdf="${page.pdf}" printed="${page.printed}">\n${body}${truncation}\n</page>`,
    })
    blocks.push({ type: 'image', attachment: imageRefFromValue(page.image) })
  }
  return blocks
}

/** Check the calling route declares image input before rendering anything. */
async function assertImageCapableRoute(ctx, exec, requestedPath) {
  __diag('ROUTE-CHECK')
  const routed = exec.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw codedError(
      `cannot read "${requestedPath}" as images: the current model route could not be resolved`,
      'PDF_READER_NO_IMAGE_ROUTE',
    )
  }
  let active
  try {
    active = await llm.resolveModelInfo(provider, model, exec.signal)
  } catch (error) {
    __diag('ROUTE-CHECK-FAILED', String(error && error.message))
    return
  }
  if (!Array.isArray(active?.inputModalities) || !active.inputModalities.includes('image')) {
    throw codedError(
      `cannot read "${requestedPath}" as images: model "${model}" does not declare image input; switch to an image-capable model`,
      'PDF_READER_NO_IMAGE_INPUT',
    )
  }
}

/** Lazy import of the PDF text/info core with a clear missing-engine error. */
function createLazyCore() {
  let pdfPromise
  let renderPromise

  function loadPdf() {
    pdfPromise ??= import('./core/pdf.js').catch((error) => {
      pdfPromise = undefined
      throw new Error(
        `dsh-pdf-reader: PDF core is unavailable (lib/core/pdf.js missing or failed to load): ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    })
    return pdfPromise
  }

  function loadRender() {
    renderPromise ??= import('./core/render.js').catch((error) => {
      renderPromise = undefined
      throw new Error(
        `dsh-pdf-reader: PDF renderer is unavailable (lib/core/render.js missing or failed to load): ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    })
    return renderPromise
  }

  return {
    async getInfo(path) {
      return (await loadPdf()).getInfo(path)
    },
    async getPageText(path, pdfPage) {
      return (await loadPdf()).getPageText(path, pdfPage)
    },
    async searchPdf(path, query, options) {
      return (await loadPdf()).searchPdf(path, query, options)
    },
    async renderPagesToPng(path, pages, options) {
      return (await loadRender()).renderPagesToPng(path, pages, options)
    },
  }
}

/** Build the route handler. Exported so tests can use fake core and stat. */
export function createRouteHandler({ config, pdfCore, infoCache, positions, statFile = stat }) {
  async function loadPositionFor(sessionId, path) {
    if (typeof sessionId === 'string' && sessionId !== '') {
      return positions.forSession(sessionId)
    }
    if (typeof path === 'string' && path !== '') {
      if (!isAbsolute(path) || !/\.pdf$/iu.test(path)) throw httpError(400, 'invalid-path')
      return positions.forPath(resolvePath(path))
    }
    return undefined
  }

  async function currentResponse(position) {
    if (position === undefined) return { ok: true, current: null }
    let info = null
    try {
      info = (await infoCache.load(position.path)).info
    } catch {
      info = null
    }
    const printedPage = printedPageFor(info, position.pdfPage, position.printedPage)
    const trail = info === null ? [] : sectionTrailForPage(info.outline, position.pdfPage)
    return {
      ok: true,
      path: position.path,
      pdfPage: position.pdfPage,
      printedPage,
      ...(trail.length === 0
        ? {}
        : {
            section: trail[trail.length - 1],
            sectionTrail: trail.map((entry) => entry.title),
          }),
    }
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith(`${ROUTE_PATH}/`)) {
      sendJson(response, 404, { ok: false, error: 'not-found' })
      return
    }
    if (!loopbackHost(request.headers.host)) {
      sendJson(response, 403, { ok: false, error: 'forbidden-host' })
      return
    }
    const method = (request.method ?? 'GET').toUpperCase()

    if (url.pathname === `${ROUTE_PATH}/info`) {
      if (method !== 'GET') {
        sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const target = await validateRouteTarget(url.searchParams.get('path') ?? '', {
        statFile,
        maxFileBytes: config.maxFileBytes,
      })
      if (!target.ok) {
        sendJson(response, target.status, { ok: false, error: target.error })
        return
      }
      try {
        const info = (await infoCache.load(target.path, target.stat)).info
        const sanitized = sanitizeOutline(info.outline, config.maxOutlineEntries)
        const labels = sanitizeLabels(info.labels, 1000)
        sendJson(response, 200, {
          ok: true,
          path: target.path,
          pageCount: Number.isInteger(info.pageCount) ? info.pageCount : 0,
          printedOffset: detectPageMode(info).offset,
          outline: sanitized.outline,
          ...(sanitized.truncated ? { outlineTruncated: true } : {}),
          ...(labels === undefined ? {} : { labels }),
        })
      } catch (error) {
        sendJson(response, 500, {
          ok: false,
          error: 'info-failed',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }

    if (url.pathname === `${ROUTE_PATH}/search`) {
      if (method !== 'GET') {
        sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const target = await validateRouteTarget(url.searchParams.get('path') ?? '', {
        statFile,
        maxFileBytes: config.maxFileBytes,
      })
      if (!target.ok) {
        sendJson(response, target.status, { ok: false, error: target.error })
        return
      }
      const query = (url.searchParams.get('q') ?? '').trim()
      if (query === '') {
        sendJson(response, 400, { ok: false, error: 'missing-query' })
        return
      }
      if (query.length > 1000) {
        sendJson(response, 400, { ok: false, error: 'query-too-long' })
        return
      }
      const rawLimit = url.searchParams.get('limit')
      let limit = config.maxSearchResults
      if (rawLimit !== null) {
        const parsed = Number(rawLimit)
        if (!Number.isInteger(parsed) || parsed < 1) {
          sendJson(response, 400, { ok: false, error: 'invalid-limit' })
          return
        }
        limit = Math.min(parsed, config.maxSearchResults)
      }
      const ignoreFlag = url.searchParams.get('ignoreCase')
      const ignoreCase = ignoreFlag === '1' || ignoreFlag === 'true'
      try {
        const result = await pdfCore.searchPdf(target.path, query, { ignoreCase, limit })
        const hits = (Array.isArray(result?.hits) ? result.hits : []).slice(0, limit).map((hit) => ({
          pdf: Number(hit.pdf),
          printed: hit.printed ?? null,
          snippet: String(hit.snippet ?? ''),
        }))
        sendJson(response, 200, { ok: true, hits })
      } catch (error) {
        sendJson(response, 500, {
          ok: false,
          error: 'search-failed',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }

    if (url.pathname === `${ROUTE_PATH}/current`) {
      if (method === 'GET') {
        const sessionId = url.searchParams.get('sessionId')
        if (sessionId !== null && (sessionId.length === 0 || sessionId.length > 200)) {
          sendJson(response, 400, { ok: false, error: 'invalid-session-id' })
          return
        }
        let position
        try {
          position = await loadPositionFor(sessionId, url.searchParams.get('path'))
        } catch (error) {
          const status = Number.isInteger(error?.status) ? error.status : 400
          sendJson(response, status, { ok: false, error: error?.error ?? 'invalid-request' })
          return
        }
        sendJson(response, 200, await currentResponse(position))
        return
      }

      if (method === 'POST') {
        const contentType = String(request.headers['content-type'] ?? '').toLowerCase()
        if (!contentType.startsWith('application/json')) {
          sendJson(response, 415, { ok: false, error: 'unsupported-media-type' })
          return
        }
        let body
        try {
          body = await readJsonBody(request, config.maxRouteBodyBytes)
        } catch (error) {
          const status = Number.isInteger(error?.status) ? error.status : 400
          sendJson(response, status, { ok: false, error: error?.error ?? 'invalid-body' })
          return
        }
        const target = await validateRouteTarget(body.path ?? '', {
          statFile,
          maxFileBytes: config.maxFileBytes,
        })
        if (!target.ok) {
          sendJson(response, target.status, { ok: false, error: target.error })
          return
        }
        const rawPage = body.pdfPage
        const pdfPage = typeof rawPage === 'string' && /^\d+$/u.test(rawPage) ? Number(rawPage) : rawPage
        if (!Number.isInteger(pdfPage) || pdfPage < 1 || pdfPage > 1_000_000) {
          sendJson(response, 400, { ok: false, error: 'invalid-page' })
          return
        }
        let sessionId = null
        if (body.sessionId !== undefined && body.sessionId !== null) {
          if (typeof body.sessionId !== 'string' || body.sessionId.length === 0 || body.sessionId.length > 200) {
            sendJson(response, 400, { ok: false, error: 'invalid-session-id' })
            return
          }
          sessionId = body.sessionId
        }
        let printedPage
        try {
          printedPage = normalizePrintedPage(body.printedPage)
        } catch {
          sendJson(response, 400, { ok: false, error: 'invalid-printed-page' })
          return
        }
        positions.record({ path: target.path, pdfPage, printedPage, sessionId })
        sendJson(response, 200, { ok: true })
        return
      }

      sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
      return
    }

    sendJson(response, 404, { ok: false, error: 'not-found' })
  }

  return async function pdfReaderRoute(request, response) {
    try {
      await handle(request, response)
    } catch (error) {
      if (response.headersSent === true) {
        if (typeof response.end === 'function') response.end()
        return
      }
      sendJson(response, 500, {
        ok: false,
        error: 'route-failed',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/** Validate a model-supplied render scale. */
function normalizeScale(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 3) {
    throw codedError('scale must be a number between 1 and 3', 'PDF_READER_INVALID_SCALE')
  }
  return value
}

/** Collapse extraction noise and cap one page's text. */
export function trimPageText(raw, maxChars) {
  if (typeof raw !== 'string') return { text: undefined, truncated: false, unavailable: true }
  const normalized = raw
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  if (normalized === '') return { text: undefined, truncated: false, unavailable: true }
  if (maxChars === 0) return { text: undefined, truncated: true, unavailable: false }
  if (normalized.length <= maxChars) return { text: normalized, truncated: false, unavailable: false }
  return { text: normalized.slice(0, maxChars), truncated: true, unavailable: false }
}

/** Register `pdf_info`, `pdf_search`, and `pdf_current_page`. */
export function createCheapTools({ defineTool: makeTool, config, core, infoCache, positions, statFile = stat }) {
  return [
    makeTool({
      name: 'pdf_info',
      description:
        'Read a PDF\'s page count, printed-page offset, page labels, and table-of-contents outline with both PDF and printed page numbers. Use this first to translate a printed page number (the number on the page) into a physical PDF page. Cheap: returns no images.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Absolute path to a .pdf file. Absolute paths are preferred; a relative path resolves against the session project directory.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            pageCount: { type: 'integer', required: true },
            printedOffset: { type: 'integer', required: true },
            pageNumberMode: { type: 'string', enum: ['printed', 'pdf'], required: true },
            outline: {
              type: 'array',
              required: true,
              items: SECTION_SCHEMA,
            },
            labels: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  pdf: { type: 'integer', required: true },
                  printed: { ...PRINTED_PAGE_SCHEMA },
                },
              },
            },
            outlineTruncated: { type: 'boolean' },
            labelsTruncated: { type: 'boolean' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        presentationMeta: (_args, value) => ({ path: value.path }),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const path = resolveToolPath(args.path, exec)
      __diag('PATH', path)
        const targetStat = await assertPdfFile(path, { statFile, maxFileBytes: config.maxFileBytes })
        const info = (await infoCache.load(path, targetStat)).info
        const detected = detectPageMode(info)
        const outlineLimit = Math.min(200, config.maxOutlineEntries)
        const sanitized = sanitizeOutline(info.outline, outlineLimit)
        const labels = sanitizeLabels(info.labels, config.maxLabels)
        return {
          path,
          pageCount: Number.isInteger(info.pageCount) ? info.pageCount : 0,
          printedOffset: detected.offset,
          pageNumberMode: detected.detectable ? 'printed' : 'pdf',
          outline: sanitized.outline,
          ...(labels === undefined || config.maxLabels === 0 ? {} : { labels }),
          ...(sanitized.truncated ? { outlineTruncated: true } : {}),
          ...(Array.isArray(info.labels) && info.labels.length > config.maxLabels && config.maxLabels > 0
            ? { labelsTruncated: true }
            : {}),
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `PDF info ${args.path}`,
        kind: 'read',
        locations: [{ path: args.path }],
      }),
    }),

    makeTool({
      name: 'pdf_search',
      description:
        'Search a PDF\'s text layer and return hit locations with short snippets. Cheap: returns no images. Use the returned PDF page numbers with pdf_read_pages. Extracted text is unreliable for mathematics, so treat hits as locations, not as evidence about a formula.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Absolute path to a .pdf file. Absolute paths are preferred; a relative path resolves against the session project directory.',
        },
        query: { type: 'string', required: true, description: 'Literal text to search for.' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive search. Defaults to true.' },
        limit: { type: 'integer', description: 'Maximum hits to return. Defaults to 20; capped by plugin config.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            query: { type: 'string', required: true },
            pages: {
              type: 'integer',
              required: true,
              description: 'Number of pages with at least one hit; may exceed the returned hit count when limit truncates.',
            },
            hits: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  pdf: { type: 'integer', required: true },
                  printed: { ...PRINTED_PAGE_SCHEMA },
                  indexOnPage: { type: 'integer' },
                  snippet: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        presentationMeta: (_args, value) => ({ path: value.path }),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const path = resolveToolPath(args.path, exec)
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        if (query === '') throw codedError('query must be a non-empty string', 'PDF_READER_INVALID_QUERY')
        if (query.length > 1000) throw codedError('query is longer than 1000 characters', 'PDF_READER_INVALID_QUERY')
        await assertPdfFile(path, { statFile, maxFileBytes: config.maxFileBytes })
        const limit = Math.max(1, Math.min(Number.isInteger(args.limit) ? args.limit : 20, config.maxSearchResults))
        const ignoreCase = args.ignore_case !== false
        const result = await core.searchPdf(path, query, { ignoreCase, limit })
        const rawHits = Array.isArray(result?.hits) ? result.hits : []
        const hits = rawHits.slice(0, limit).map((hit) => ({
          pdf: Number(hit.pdf),
          printed: hit.printed ?? null,
          ...(Number.isInteger(hit.indexOnPage) ? { indexOnPage: hit.indexOnPage } : {}),
          snippet: String(hit.snippet ?? ''),
        }))
        return {
          path,
          query,
          pages: Number.isInteger(result?.pages) ? result.pages : new Set(hits.map((hit) => hit.pdf)).size,
          hits,
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `Search PDF ${args.query}`,
        kind: 'read',
        locations: [{ path: args.path }],
      }),
    }),

    makeTool({
      name: 'pdf_current_page',
      description:
        'Report the page the user is currently viewing in the browser PDF preview, with the outline section containing it. Cheap: returns no images. Use when the user says "this page"/"当前页" without naming a number.',
      parameters: {
        path: {
          type: 'string',
          description: 'Optional expected PDF path. When supplied and it differs from the reported book, returns current:null.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            current: {
              oneOf: [
                { type: 'null' },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true },
                    book: { type: 'string', required: true },
                    pdfPage: { type: 'integer', required: true },
                    printedPage: { ...PRINTED_PAGE_SCHEMA, required: true },
                    pageNumberMode: { type: 'string', enum: ['printed', 'pdf'], required: true },
                    section: { ...SECTION_SCHEMA },
                    sectionTrail: { type: 'array', items: { type: 'string' } },
                    updatedAt: { type: 'integer', required: true },
                  },
                },
              ],
              required: true,
            },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        presentationMeta: (_args, value) => ({ path: value?.current?.path }),
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const sessionId = exec?.agent?.session?.id
        const position = typeof sessionId === 'string' ? positions.forSession(sessionId) : undefined
        if (position === undefined) return { current: null, reason: 'no-reading-position' }
        if (args.path !== undefined) {
          const expected = resolveToolPath(args.path, exec)
          if (expected !== position.path) return { current: null, reason: 'path-mismatch' }
        }
        let info = null
        try {
          info = (await infoCache.load(position.path)).info
        } catch {
          info = null
        }
        const trail = info === null ? [] : sectionTrailForPage(info.outline, position.pdfPage)
        const printedPage = printedPageFor(info, position.pdfPage, position.printedPage)
        return {
          current: {
            path: position.path,
            book: titleFromPath(position.path),
            pdfPage: position.pdfPage,
            printedPage,
            pageNumberMode: typeof printedPage === 'number' ? 'printed' : 'pdf',
            ...(trail.length === 0 ? {} : { section: trail[trail.length - 1], sectionTrail: trail.map((entry) => entry.title) }),
            updatedAt: position.updatedAt,
          },
        }
      },
      presentCall: () => ({
        card: 'generic',
        title: 'Current PDF page',
        kind: 'read',
      }),
    }),
  ]
}

/** Register `pdf_read_pages` into a context that has the attachments service. */
export function createReadPagesTool({ defineTool: makeTool, ctx, config, core, infoCache, statFile = stat }) {
  return makeTool({
    name: 'pdf_read_pages',
    description:
      'Render a small number of PDF pages (default max 4, configurable) to images and read them with vision, with a short text extract beside each image. `pages` accepts printed page numbers (the numbers on the page; the default when the PDF has a numeric printed-page offset) or physical PDF pages. Pass page_numbers:"pdf" to force physical pages. This is the only tool that returns images, so use it when the exact typography of a page matters (formulas, theorem statements, figures). Each image costs roughly 350-1024 tokens depending on scale and crop; the per-call cap is enforced.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path to a .pdf file. Absolute paths are preferred; a relative path resolves against the session project directory.',
      },
      pages: {
        required: true,
        description:
          '1-based pages to render: "132-134", "132,135", 132, or [132,133,134]. Interpreted as printed numbers when the PDF has a printed-page offset, unless page_numbers is "pdf".',
        oneOf: [
          { type: 'integer' },
          { type: 'string' },
          { type: 'array', items: { oneOf: [{ type: 'integer' }, { type: 'string' }] } },
        ],
      },
      page_numbers: {
        type: 'string',
        enum: ['printed', 'pdf'],
        description:
          'How to interpret `pages`. Defaults to "printed" when the PDF exposes numeric printed-page labels, otherwise "pdf".',
      },
      scale: {
        type: 'number',
        description: 'Render scale from 1 to 3. Defaults to 2.5. Use 3 with crop for dense subscripts; never above 3.',
      },
      crop: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'number' } },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              x: { type: 'number', required: true },
              y: { type: 'number', required: true },
              w: { type: 'number', required: true },
              h: { type: 'number', required: true },
            },
          },
        ],
        description:
          'Optional crop as "x0,y0,x1,y1" fractions, [x0,y0,x1,y1], or {x,y,w,h} with a top-left origin, e.g. "0,0,1,0.55" or {x:0,y:0,w:1,h:0.55} for the top 55%.',
      },
      image_quality: {
        type: 'string',
        enum: ['cheap', 'standard'],
        description:
          'Cost/readability preset: "cheap" renders at 1.5x (about 350 tokens/page, prose only); "standard" uses the default 2.5x (about 900 tokens/page). An explicit scale wins.',
      },
      include_text: {
        type: 'boolean',
        description:
          'Include a capped text extract beside each image. Defaults to true. The image is the evidence; text is an index.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          book: { type: 'string', required: true },
          pageNumbers: { type: 'string', enum: ['printed', 'pdf'], required: true },
          printedOffset: { type: 'integer', required: true },
          textIncluded: { type: 'boolean', required: true },
          pages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                pdf: { type: 'integer', required: true },
                printed: { oneOf: [{ type: 'integer' }, { type: 'string' }], required: true },
                image: IMAGE_VALUE_SCHEMA,
                text: { type: 'string' },
                textTruncated: { type: 'boolean' },
                textUnavailable: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (_args, value) => renderPageReadContent(value),
      presentationMeta: (_args, value) => ({ path: value.path, pages: value.pages.map((page) => page.pdf) }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      __diag('ENTER', JSON.stringify(args))
      try {
      const path = resolveToolPath(args.path, exec)
      const targetStat = await assertPdfFile(path, { statFile, maxFileBytes: config.maxFileBytes })
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw codedError('cannot read PDF pages as images: no attachment service is mounted', 'PDF_READER_NO_ATTACHMENTS')
      }
      await assertImageCapableRoute(ctx, exec, path)
      const info = (await infoCache.load(path, targetStat)).info
      const resolved = resolveRequestedPages({
        selection: args.pages,
        pageNumbers: args.page_numbers,
        info,
        maxPages: config.maxPagesPerCall,
      })
      const requestedScale =
        args.scale ?? (args.image_quality === 'cheap' ? 1.5 : config.defaultScale)
      const scale = normalizeScale(requestedScale, config.defaultScale)
      const crop = parseCrop(args.crop)
      let rendered
      try {
        __diag('RENDER-START', JSON.stringify(resolved.pdfPages))
        rendered = await core.renderPagesToPng(path, resolved.pdfPages, {
          scale,
          ...(crop === undefined ? {} : { crop }),
        })
      } catch (error) {
        if (error?.code === 'PDF_PAGE_OUT_OF_RANGE') {
          throw codedError(error.message, 'PDF_READER_INVALID_PAGE')
        }
        throw error
      }
      const byPdf = new Map()
      for (const page of Array.isArray(rendered) ? rendered : []) {
        const pdf = Number(page?.pdf)
        if (Number.isFinite(pdf)) byPdf.set(pdf, page)
      }
      const includeText = args.include_text !== false && config.maxTextCharsPerPage > 0
      const book = titleFromPath(path)
      const safeName = book.replace(/[^A-Za-z0-9._-]+/gu, '_').slice(0, 60) || 'page'
      __diag('RENDERED')
      const pages = []
      for (const pdf of resolved.pdfPages) {
        const page = byPdf.get(pdf)
        if (page === undefined || page.buffer === undefined || page.buffer.byteLength === 0) {
          throw codedError(`renderer returned no PNG for PDF page ${pdf}`, 'PDF_READER_RENDER_FAILED')
        }
        let textResult = { text: undefined, truncated: false, unavailable: false }
        if (includeText) {
          try {
            textResult = trimPageText(await core.getPageText(path, pdf), config.maxTextCharsPerPage)
          } catch {
            textResult = { text: undefined, truncated: false, unavailable: true }
          }
        }
        let ref
        try {
          ref = await attachments.saveImage({
            data: page.buffer,
            mediaType: 'image/png',
            name: `${safeName}-p${pdf}.png`,
          })
        } catch (error) {
          const code = error?.code
          if (code === 'IMAGE_DIMENSION_TOO_LARGE' || code === 'IMAGE_TOO_MANY_PIXELS' || code === 'IMAGE_TOO_LARGE') {
            throw codedError(
              `cannot store PDF page ${pdf} as an image: ${error.message}; lower scale or crop the page and retry`,
              'PDF_READER_IMAGE_TOO_LARGE',
            )
          }
          throw error
        }
        __diag('SAVED', pdf + ' ' + JSON.stringify(ref))
        if (typeof ref?.attachmentId !== 'string') {
          throw codedError(`attachment store returned no reference for PDF page ${pdf}`, 'PDF_READER_ATTACHMENT_FAILED')
        }
        pages.push({
          pdf,
          printed:
            resolved.mode === 'printed'
              ? pdf - resolved.printedOffset
              : (page.printed ?? pdf),
          image: {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType ?? 'image/png',
            bytes: ref.bytes ?? page.buffer.byteLength,
            width: ref.width ?? page.width,
            height: ref.height ?? page.height,
            ...(ref.name === undefined ? {} : { name: ref.name }),
            ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }),
          },
          ...(textResult.text === undefined ? {} : { text: textResult.text }),
          ...(textResult.truncated ? { textTruncated: true } : {}),
          ...(textResult.unavailable ? { textUnavailable: true } : {}),
        })
      }
      __diag('DONE')
      return {
        path,
        book,
        pageNumbers: resolved.mode,
        printedOffset: resolved.printedOffset,
        textIncluded: includeText,
        pages,
      }
      } catch (error) {
        __diag('ERR', (error && error.message) + '\n' + (error && error.stack))
        throw error
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Read PDF pages ${Array.isArray(args.pages) ? args.pages.join(',') : args.pages}`,
      kind: 'read',
      locations: [{ path: args.path }],
    }),
  })
}

/**
 * Mount the host half: one prefix route, three cheap tools, the image tool
 * while attachments are mounted, and one prepended pre-step listener.
 * @param ctx - Cordis plugin context.
 * @param rawConfig - plugin config; defaults are applied here as well as by the loader.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return

  const core = createLazyCore()
  const infoCache = createInfoCache({
    getInfo: core.getInfo,
    statFile: stat,
    limit: config.infoCacheSize,
  })
  const positions = createPositionStore()

  const routeHandler = createRouteHandler({
    config,
    pdfCore: core,
    infoCache,
    positions,
    statFile: stat,
  })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PATH, handler: routeHandler }),
    'dsh-pdf-reader: HTTP routes',
  )

  for (const tool of createCheapTools({
    defineTool,
    config,
    core,
    infoCache,
    positions,
    statFile: stat,
  })) {
    ctx.tools.register(tool)
  }

  ctx.inject(['attachments'], (attachmentCtx) => {
    attachmentCtx.tools.register(
      createReadPagesTool({
        defineTool,
        ctx: attachmentCtx,
        config,
        core,
        infoCache,
        statFile: stat,
      }),
    )
  })

  if (config.autoShare) {
    const listener = createAutoShareListener({ config, positions, infoCache })
    ctx.on('agent/pre-step', listener, { prepend: true })
  }
}
