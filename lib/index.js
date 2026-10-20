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
 * - Auto-share is per-session and deliberately conservative: at most one
 *   message per turn, and only when the page changed since the last hint.
 *
 * @module dsh-pdf-reader
 */

import { basename, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { estimateImageTokens, estimateTextTokens } from './core/tokens.js'
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
  /** Remember page/zoom per PDF and restore on reopen. */
  rememberView: z.boolean().default(true),
  /** Inject the current reading page into `agent/pre-step`, at most once per turn. */
  autoShare: z.boolean().default(true),
  /** Resolve the outline section for the injected message (one cached getInfo). */
  autoShareSection: z.boolean().default(true),
  /** Optional minimum milliseconds between hints; 0 = no time throttle. */
  autoShareMinIntervalMs: z.number().default(0),
  /** Minimum absolute page change required before another hint. */
  autoSharePageDelta: z.number().default(1),
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
  /** Maximum page labels included by `pdf_info`; 0 omits them (cheapest). */
  maxLabels: z.number().default(0),
  /** Deepest outline level `pdf_info` returns; 0=chapters, 1=sections (default), 2=subsections. */
  outlineDepth: z.number().default(1),
  /** Append one JSON cost line per expensive tool call to <plugin>/.debug-cost.log. */
  debugCost: z.boolean().default(false),
  /** Include internal error detail in HTTP 500 bodies (development only). */
  debug: z.boolean().default(false),
  /** Allow tools to open PDFs outside the session workspace (default: no). */
  allowOutsideWorkspace: z.boolean().default(false),
  /** Extra route-level allowlist of directories; empty = allow any (UI compatibility). */
  routeAllowedRoots: z.array(z.string()).default([]),
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
  rememberView: true,
  autoShare: true,
  autoShareSection: true,
  autoShareMinIntervalMs: 0,
  autoSharePageDelta: 1,
  autoShareMaxAgeMs: 0,
  maxPagesPerCall: 4,
  defaultScale: 2.5,
  maxTextCharsPerPage: 1200,
  maxSearchResults: 100,
  maxOutlineEntries: 500,
  maxLabels: 0,
  outlineDepth: 1,
  debugCost: false,
  debug: false,
  allowOutsideWorkspace: false,
  routeAllowedRoots: [],
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
    rememberView: configBoolean(source.rememberView, DEFAULT_CONFIG.rememberView, 'rememberView'),
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
    outlineDepth: configInteger(source.outlineDepth, DEFAULT_CONFIG.outlineDepth, 'outlineDepth', 0, 5),
    debugCost: source.debugCost === undefined ? DEFAULT_CONFIG.debugCost : source.debugCost === true,
    debug: source.debug === undefined ? DEFAULT_CONFIG.debug : source.debug === true,
    allowOutsideWorkspace: source.allowOutsideWorkspace === true,
    routeAllowedRoots: Array.isArray(source.routeAllowedRoots)
      ? source.routeAllowedRoots.filter((entry) => typeof entry === 'string' && isAbsolute(entry))
      : [],
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
export async function validateRouteTarget(rawPath, { statFile = stat, maxFileBytes = DEFAULT_CONFIG.maxFileBytes, allowedRoots = [] } = {}) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { ok: false, status: 400, error: 'invalid-path' }
  }
  if (!isAbsolute(rawPath)) return { ok: false, status: 400, error: 'invalid-path' }
  const path = resolvePath(rawPath)
  if (Array.isArray(allowedRoots) && allowedRoots.length > 0) {
    const allowed = allowedRoots.some((root) => {
      const rel = relative(resolvePath(root), path)
      return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
    })
    if (!allowed) return { ok: false, status: 403, error: 'path-outside-allowed-roots' }
  }
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

// ---------------------------------------------------------------------------
// Remembered page/zoom view state
// ---------------------------------------------------------------------------

/** Durable storage-domain name for remembered book views. */
export const VIEW_DOMAIN_NAME = 'book_reader_views'

/** Format version of {@link VIEW_DOMAIN_NAME}; bump only with a migration. */
export const VIEW_DOMAIN_VERSION = 1

/** Table holding one remembered view per book inside {@link VIEW_DOMAIN_NAME}. */
export const VIEW_TABLE_NAME = 'views'

/** Hard cap on remembered books; the oldest records are pruned past this. */
export const MAX_VIEW_RECORDS = 500

/** Longest accepted book path in a `/view` request. */
export const MAX_VIEW_PATH_LENGTH = 4096

/** Hard ceiling for a remembered PDF page number. */
export const MAX_VIEW_PAGE = 100_000

/** The only accepted zoom modes (mirrors the client's toolbar). */
export const VIEW_ZOOM_MODES = Object.freeze(['fit-width', 'fixed'])

/** Smallest accepted zoom ratio. */
export const VIEW_ZOOM_SCALE_MIN = 0.25

/** Largest accepted zoom ratio. */
export const VIEW_ZOOM_SCALE_MAX = 4

/**
 * Stable storage key for one book: sha256 hex of the absolute path.
 * @param path - normalized absolute `.pdf` path.
 * @returns 64 lowercase hex characters.
 */
export function viewKeyForPath(path) {
  return createHash('sha256').update(path, 'utf8').digest('hex')
}

/**
 * Declarative zod schema for one remembered view.
 *
 * The schema is the durable-boundary validator of the storage domain. The
 * HTTP route validates requests itself, so this stays purely declarative and
 * needs no zod call at request time.
 * @param zod - the dynamically imported zod module namespace.
 * @returns a zod object schema matching the `/view` record contract.
 */
export function viewRecordSchema(zod) {
  return zod.object({
    path: zod.string().min(1).max(MAX_VIEW_PATH_LENGTH),
    pdfPage: zod.number().int().min(1).max(MAX_VIEW_PAGE),
    zoomMode: zod.enum([...VIEW_ZOOM_MODES]),
    zoomScale: zod.number().min(VIEW_ZOOM_SCALE_MIN).max(VIEW_ZOOM_SCALE_MAX),
    updatedAt: zod.number().int().nonnegative(),
  })
}

/**
 * Build the `book_reader_views` domain declaration.
 *
 * `zod` and the domain helpers are imported dynamically so this module still
 * loads where the storage packages are absent; callers must handle rejection.
 * @returns the domain spec understood by `ctx.storageDomain.open`.
 */
export async function createViewDomainSpec() {
  const [{ defineDomain, domainTable }, { z: zod }] = await Promise.all([
    import('@deepseek-ai/dsh-storage-domain'),
    import('zod'),
  ])
  return defineDomain({
    name: VIEW_DOMAIN_NAME,
    version: VIEW_DOMAIN_VERSION,
    layout: 'single',
    tables: {
      [VIEW_TABLE_NAME]: domainTable(viewRecordSchema(zod)),
    },
  })
}

/**
 * Open the remembered-view domain through the injected `storageDomain` service.
 * @param storageDomain - the `ctx.storageDomain` facility (DomainFacility).
 * @returns the opened domain handle; the caller owns `close()`.
 * @throws when the service, the modules, or `open` itself are unavailable.
 */
export async function openViewStateDomain(storageDomain) {
  if (storageDomain === null || typeof storageDomain !== 'object' || typeof storageDomain.open !== 'function') {
    throw new TypeError('pdf-reader: storageDomain service is unavailable')
  }
  const spec = await createViewDomainSpec()
  const domain = await storageDomain.open(spec)
  if (domain === null || typeof domain !== 'object' || typeof domain.table !== 'function') {
    throw new TypeError('pdf-reader: storageDomain.open returned no domain')
  }
  return domain
}

/** Whether one stored value is a usable view record for the requested path. */
function isViewRecordFor(record, path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_VIEW_PATH_LENGTH) return false
  if (record === null || typeof record !== 'object') return false
  if (record.path !== path) return false
  if (!Number.isInteger(record.pdfPage) || record.pdfPage < 1 || record.pdfPage > MAX_VIEW_PAGE) return false
  if (record.zoomMode !== 'fit-width' && record.zoomMode !== 'fixed') return false
  if (typeof record.zoomScale !== 'number' || !Number.isFinite(record.zoomScale)) return false
  if (record.zoomScale < VIEW_ZOOM_SCALE_MIN || record.zoomScale > VIEW_ZOOM_SCALE_MAX) return false
  if (!Number.isInteger(record.updatedAt) || record.updatedAt < 0) return false
  return true
}

/** Project one stored record to the exact client-facing shape. */
function publicViewRecord(record) {
  return {
    path: record.path,
    pdfPage: record.pdfPage,
    zoomMode: record.zoomMode,
    zoomScale: record.zoomScale,
    updatedAt: record.updatedAt,
  }
}

/**
 * Delete the least recently updated records once the table exceeds the cap.
 * Best-effort: pruning never rejects an already-durable write.
 * @param table - an open domain table handle.
 */
async function pruneViewTable(table) {
  try {
    if (table.size <= MAX_VIEW_RECORDS) return
    const excess = table.size - MAX_VIEW_RECORDS
    const oldest = [...table.entries()]
      .sort((left, right) => {
        const leftAt = Number.isFinite(left[1]?.updatedAt) ? left[1].updatedAt : 0
        const rightAt = Number.isFinite(right[1]?.updatedAt) ? right[1].updatedAt : 0
        return leftAt - rightAt
      })
      .slice(0, excess)
    for (const [key] of oldest) await table.delete(key)
  } catch {
    // The record is already durable; a failed prune is not a failed write.
  }
}

/**
 * Route-facing adapter over the opened `book_reader_views` domain.
 *
 * `apply()` attaches the table once storage is open and detaches it on
 * unload. Until then (or forever, when storage is unavailable) `read()`
 * answers `null` and `write()` answers `false`, so routes degrade without
 * throwing. Every failure is contained here and reported to `warn` once.
 * @param options - warning sink; defaults to `console.warn`.
 * @returns a mutable adapter read by the route handler.
 */
export function createViewStateAdapter({ warn = console.warn } = {}) {
  let table = null
  let warned = false

  function warnOnce(message, error) {
    if (warned) return
    warned = true
    try {
      const detail = error instanceof Error ? `: ${error.message}` : ''
      warn(`dsh-pdf-reader: ${message}${detail}`)
    } catch {
      // A broken logger must not break plugin loading or routing.
    }
  }

  return {
    /** Whether an open domain table is currently attached. */
    get available() {
      return table !== null
    },
    /** Attach the table of a successfully opened domain. */
    attach(nextTable) {
      table = nextTable ?? null
    },
    /** Detach on unload so in-flight routes degrade instead of throwing. */
    detach() {
      table = null
    },
    /** Emit at most one warning for this adapter. */
    warnOnce,
    /**
     * Read the remembered view for one normalized absolute path.
     * @returns the public record, or `null` when absent/unavailable/invalid.
     */
    async read(path) {
      const current = table
      if (current === null) return null
      try {
        const record = current.get(viewKeyForPath(path))
        if (!isViewRecordFor(record, path)) return null
        return publicViewRecord(record)
      } catch (error) {
        warnOnce('could not read the remembered page/zoom', error)
        return null
      }
    },
    /**
     * Persist one complete view record (key hashed from `record.path`).
     * @returns true when durable, false when storage is unavailable/failed.
     */
    async write(record) {
      const current = table
      if (current === null) return false
      try {
        const value = {
          path: record.path,
          pdfPage: record.pdfPage,
          zoomMode: record.zoomMode,
          zoomScale: record.zoomScale,
          updatedAt: Number.isInteger(record.updatedAt) ? record.updatedAt : Date.now(),
        }
        await current.put(viewKeyForPath(value.path), value)
        await pruneViewTable(current)
        return true
      } catch (error) {
        warnOnce('could not remember the page/zoom', error)
        return false
      }
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
export function sanitizeOutline(outline, limit = DEFAULT_CONFIG.maxOutlineEntries, maxDepth = Infinity) {
  if (!Array.isArray(outline)) return { outline: [], truncated: false }
  const eligible = outline.filter(
    (entry) => entry !== null && typeof entry === 'object' && Number.isFinite(Number(entry.pdf)),
  )
  const entries = eligible
    .filter((entry) => (Number.isInteger(entry.depth) ? entry.depth : 0) <= maxDepth)
    .slice(0, limit)
    .map(outlineEntry)
  return { outline: entries, truncated: entries.length < eligible.length }
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
  // Deliberately minimal: a position marker only. Whether and what to read is
  // the model's decision (see SKILL.md); no tool-call hint is injected, which
  // keeps every turn cheap and avoids steering the model.
  const label =
    printable === null
      ? `PDF ${pdfPage}`
      : `printed ${printable} (PDF ${pdfPage})`
  const suffix = sectionText === '' ? '' : ` \u00b7 ${sectionText}`
  return `[dsh-pdf-reader] \u6b63\u5728\u9605\u8bfb\u300a${book}\u300b${label}${suffix}`
}

/** Whether two injection state records refer to the same page. */
function sameInjectedPage(state, position) {
  return state.lastInjectedPath === position.path && state.lastInjectedPdfPage === position.pdfPage
}

/**
 * Decide whether this turn should receive a reading-position message.
 *
 * One hint per turn at most: the guard is the turn number, not the step, and
 * the hint is only sent when the reported page changed since the last one.
 * Pure: callers own the state map and the clock.
 * @param options - position, prior state, turn, clock, and config.
 * @returns `{ inject, reason, nextState }`; `nextState` is unchanged when false.
 */
export function decideAutoShare({ position, state = INITIAL_AUTO_SHARE_STATE, now, turn, config = DEFAULT_CONFIG }) {
  const keep = { inject: false, reason: '', nextState: state }
  if (!config.autoShare) return { ...keep, reason: 'disabled' }
  if (position === null || position === undefined) return { ...keep, reason: 'no-position' }
  if (sameInjectedPage(state, position)) return { ...keep, reason: 'unchanged' }
  if (config.autoShareMaxAgeMs > 0) {
    if (typeof position.updatedAt !== 'number') return { ...keep, reason: 'unknown-age' }
    if (now - position.updatedAt > config.autoShareMaxAgeMs) return { ...keep, reason: 'stale' }
  }
  if (Number.isInteger(turn) && state.lastInjectedTurn === turn) return { ...keep, reason: 'same-turn' }
  if (config.autoShareMinIntervalMs > 0 && state.lastInjectedAt !== null && state.lastInjectedAt !== undefined) {
    const elapsed = now - state.lastInjectedAt
    if (!(elapsed >= config.autoShareMinIntervalMs)) return { ...keep, reason: 'throttled' }
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

/** Refuse a tool path outside the session workspace unless config allows it. */
export function assertInsideWorkspace(path, exec, config = DEFAULT_CONFIG) {
  if (config.allowOutsideWorkspace === true) return path
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return path
  const root = resolvePath(cwd)
  const rel = relative(root, path)
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return path
  throw codedError(
    `"${path}" is outside the session workspace (${root}); set allowOutsideWorkspace:true to read it`,
    'PDF_OUTSIDE_WORKSPACE',
  )
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

/**
 * Validate a `/view` book path without touching the filesystem.
 *
 * The remembered-view route deliberately does not stat the PDF: the client
 * may report a state for a book whose preview is still opening, and restoring
 * a missing book's state is harmless. The shape and size checks still mirror
 * the rest of the route surface.
 * @param rawPath - the raw query/body `path` value.
 * @returns the normalized absolute path, or `null` when invalid.
 */
function validateViewPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > MAX_VIEW_PATH_LENGTH) return null
  if (!isAbsolute(rawPath)) return null
  const path = resolvePath(rawPath)
  if (!/\.pdf$/iu.test(path)) return null
  return path
}

/** Build the route handler. Exported so tests can use fake core and stat. */
export function createRouteHandler({
  config,
  pdfCore,
  infoCache,
  positions,
  statFile = stat,
  views = createViewStateAdapter(),
}) {
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
        allowedRoots: config.routeAllowedRoots,
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
        allowedRoots: config.routeAllowedRoots,
      })
      if (!target.ok) {
        sendJson(response, target.status, { ok: false, error: target.error })
        return
      }
      let query
      try {
        query = cleanPdfSearchQuery(url.searchParams.get('q') ?? '')
      } catch (error) {
        const tooLong = error instanceof RangeError
        sendJson(response, 400, { ok: false, error: tooLong ? 'query-too-long' : 'missing-query' })
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
        const mode = ['phrase', 'compact', 'terms'].includes(result?.mode) ? result.mode : 'phrase'
        sendJson(response, 200, { ok: true, mode, hits })
      } catch (error) {
        if (
          error?.code === 'PDF_SEARCH_QUERY_TOO_LONG' ||
          (error instanceof TypeError && /query must be a non-empty string/u.test(error.message))
        ) {
          const tooLong = error?.code === 'PDF_SEARCH_QUERY_TOO_LONG'
          sendJson(response, 400, { ok: false, error: tooLong ? 'query-too-long' : 'missing-query' })
          return
        }
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
          allowedRoots: config.routeAllowedRoots,
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

    if (url.pathname === `${ROUTE_PATH}/view`) {
      const rememberView = config.rememberView !== false
      if (method === 'GET') {
        const path = validateViewPath(url.searchParams.get('path') ?? '')
        if (path === null) {
          sendJson(response, 400, { ok: false, error: 'invalid-path' })
          return
        }
        // Disabled remembering and unavailable storage both answer the same
        // non-blocking shape, so restoring a book never fails the preview.
        if (!rememberView) {
          sendJson(response, 200, { ok: true, view: null })
          return
        }
        let view = null
        try {
          view = await views.read(path)
        } catch {
          view = null
        }
        sendJson(response, 200, { ok: true, view: view ?? null })
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
        const path = validateViewPath(body.path)
        if (path === null) {
          sendJson(response, 400, { ok: false, error: 'invalid-path' })
          return
        }
        if (!Number.isInteger(body.pdfPage) || body.pdfPage < 1 || body.pdfPage > MAX_VIEW_PAGE) {
          sendJson(response, 400, { ok: false, error: 'invalid-page' })
          return
        }
        if (body.zoomMode !== 'fit-width' && body.zoomMode !== 'fixed') {
          sendJson(response, 400, { ok: false, error: 'invalid-zoom-mode' })
          return
        }
        if (
          typeof body.zoomScale !== 'number' ||
          !Number.isFinite(body.zoomScale) ||
          body.zoomScale < VIEW_ZOOM_SCALE_MIN ||
          body.zoomScale > VIEW_ZOOM_SCALE_MAX
        ) {
          sendJson(response, 400, { ok: false, error: 'invalid-zoom-scale' })
          return
        }
        // Remembering may be disabled while previews still talk to the route:
        // validation stays complete, the write becomes a deliberate no-op.
        if (!rememberView) {
          sendJson(response, 200, { ok: true })
          return
        }
        let stored = false
        try {
          stored =
            (await views.write({
              path,
              pdfPage: body.pdfPage,
              zoomMode: body.zoomMode,
              zoomScale: body.zoomScale,
              updatedAt: Date.now(),
            })) === true
        } catch {
          stored = false
        }
        if (!stored) {
          sendJson(response, 503, { ok: false, error: 'storage-unavailable' })
          return
        }
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
        ...(config.debug === true
          ? { detail: error instanceof Error ? error.message : String(error) }
          : {}),
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

/** Longest search query accepted after wrapper/whitespace cleanup. */
const MAX_SEARCH_QUERY_LENGTH = 1000

/** Whole-query wrappers the model may add around a search query. */
const SEARCH_QUERY_WRAPPERS = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['`', '`'],
  ['$', '$'],
]

/**
 * Tool/route-side search-query cleanup: trim, strip a pair of wrapping
 * quotes/backticks/`$…$`, collapse whitespace, and reject empty/over-long
 * input.  Mirrors `cleanSearchQuery()` in core/pdf.js; kept local because the
 * PDF core is imported lazily, only when a PDF operation actually runs.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function cleanPdfSearchQuery(raw) {
  if (typeof raw !== 'string') throw new TypeError('query must be a non-empty string')

  let query = raw.trim()
  let stripped = true
  while (stripped && query.length >= 2) {
    stripped = false
    for (const [open, close] of SEARCH_QUERY_WRAPPERS) {
      if (query.startsWith(open) && query.endsWith(close)) {
        query = query.slice(open.length, query.length - close.length).trim()
        stripped = true
        break
      }
    }
  }

  query = query.replace(/\s+/gu, ' ').trim()
  if (query === '') throw new TypeError('query must be a non-empty string')
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new RangeError(`query is longer than ${MAX_SEARCH_QUERY_LENGTH} characters`)
  }
  return query
}

/** Register `pdf_info` and `pdf_search`. */
export function createCheapTools({ defineTool: makeTool, config, core, infoCache, statFile = stat }) {
  return [
    makeTool({
      name: 'pdf_info',
      description:
        'PDF map: page count, printed↔physical page offset, and the outline/TOC. Text only, cheap.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Absolute .pdf path (relative resolves against the session directory).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            title: { type: 'string' },
            author: { type: 'string' },
            fileSizeBytes: { type: 'integer' },
            pageCount: { type: 'integer', required: true },
            printedOffset: { type: 'integer', required: true },
            pageSize: {
              type: 'object',
              additionalProperties: false,
              properties: {
                width: { type: 'number', required: true },
                height: { type: 'number', required: true },
              },
            },
            textCoverage: {
              type: 'object',
              additionalProperties: false,
              properties: {
                isLikelyScanned: { type: 'boolean', required: true },
                ratio: { type: 'number', required: true },
                sampledPages: { type: 'integer', required: true },
              },
            },
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
        assertInsideWorkspace(path, exec, config)
        const targetStat = await assertPdfFile(path, { statFile, maxFileBytes: config.maxFileBytes })
        const info = (await infoCache.load(path, targetStat)).info
        const detected = detectPageMode(info)
        const outlineLimit = Math.min(200, config.maxOutlineEntries)
        const sanitized = sanitizeOutline(info.outline, outlineLimit, config.outlineDepth)
        const labels = sanitizeLabels(info.labels, config.maxLabels)
        const docMeta = info.documentMetadata ?? {}
        const coverage = info.textCoverage ?? {}
        return {
          path,
          title: typeof docMeta.title === 'string' ? docMeta.title : titleFromPath(path),
          ...(typeof docMeta.author === 'string' ? { author: docMeta.author } : {}),
          fileSizeBytes: Number.isFinite(targetStat?.size) ? targetStat.size : undefined,
          pageCount: Number.isInteger(info.pageCount) ? info.pageCount : 0,
          printedOffset: detected.offset,
          pageNumberMode: detected.detectable ? 'printed' : 'pdf',
          ...(info.pageSize === null || info.pageSize === undefined ? {} : { pageSize: { ...info.pageSize } }),
          ...(typeof coverage.ratio === 'number'
            ? { textCoverage: { isLikelyScanned: coverage.isLikelyScanned === true, ratio: coverage.ratio, sampledPages: coverage.sampledPages } }
            : {}),
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
        'Search a PDF\'s text layer; returns page numbers, snippets, and the matching mode. Literal-ish search over normalized text: case-insensitive by default, tolerant of wrapping quotes/backticks and `$…$` LaTeX markup, hyphen/space-insensitive fallback, then term-AND fallback when no literal match. Body pages rank before front matter. Text only, cheap.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Absolute .pdf path (relative resolves against the session directory).',
        },
        query: {
          type: 'string',
          required: true,
          description:
            'Text or formula to find. Wrapping quotes/backticks/$…$ are stripped; use a distinctive phrase.',
        },
        ignore_case: { type: 'boolean', description: 'Case-insensitive search. Defaults to true.' },
        limit: { type: 'integer', description: 'Maximum hits to return. Defaults to 30; capped by plugin config.' },
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
            mode: {
              type: 'string',
              enum: ['phrase', 'compact', 'terms'],
              required: true,
              description:
                'Which pass produced the hits: literal phrase, space-insensitive, or all-terms.',
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
        assertInsideWorkspace(path, exec, config)
        let query
        try {
          query = cleanPdfSearchQuery(args.query)
        } catch (error) {
          throw codedError(
            error instanceof Error ? error.message : String(error),
            'PDF_READER_INVALID_QUERY',
          )
        }
        await assertPdfFile(path, { statFile, maxFileBytes: config.maxFileBytes })
        const limit = Math.max(1, Math.min(Number.isInteger(args.limit) ? args.limit : 30, config.maxSearchResults))
        const ignoreCase = args.ignore_case !== false
        let result
        try {
          result = await core.searchPdf(path, query, { ignoreCase, limit })
        } catch (error) {
          // Cleanup above already rejects ordinary empties; core also rejects a
          // query that normalization erases entirely (e.g. "---").
          if (
            error?.code === 'PDF_SEARCH_QUERY_TOO_LONG' ||
            (error instanceof TypeError && /query must be a non-empty string/u.test(error.message))
          ) {
            throw codedError(error.message, 'PDF_READER_INVALID_QUERY')
          }
          throw error
        }
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
          mode: ['phrase', 'compact', 'terms'].includes(result?.mode) ? result.mode : 'phrase',
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
  ]
}

/** Register `pdf_read_pages` into a context that has the attachments service. */
export function createReadPagesTool({ defineTool: makeTool, ctx, config, core, infoCache, statFile = stat }) {
  return makeTool({
    name: 'pdf_read_pages',
    description:
      'Read chosen PDF pages. Returns extracted text, optionally the rendered images (include_image:false for text only). Both page_numberings accepted.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute .pdf path (relative resolves against the session directory).',
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
      include_image: {
        type: 'boolean',
        description: 'Render page images. Defaults to true. false returns text only, with no image tokens.',
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
          imageTokens: { type: 'integer' },
          pages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                pdf: { type: 'integer', required: true },
                printed: { oneOf: [{ type: 'integer' }, { type: 'string' }], required: true },
                tokens: { type: 'integer' },
                image: { ...IMAGE_VALUE_SCHEMA, required: false },
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
      try {
      const path = resolveToolPath(args.path, exec)
        assertInsideWorkspace(path, exec, config)
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
      const includeImage = args.include_image !== false
      if (!includeImage) {
        const book = titleFromPath(path)
        const includeText = args.include_text !== false && config.maxTextCharsPerPage > 0
        const pages = []
        for (const pdf of resolved.pdfPages) {
          let textResult = { text: undefined, truncated: false, unavailable: false }
          if (includeText) {
            try {
              textResult = trimPageText(await core.getPageText(path, pdf), config.maxTextCharsPerPage)
            } catch {
              textResult = { text: undefined, truncated: false, unavailable: true }
            }
          }
          pages.push({
            pdf,
            printed: resolved.mode === 'printed' ? pdf - resolved.printedOffset : pdf,
            tokens: 0,
            ...(textResult.text === undefined ? {} : { text: textResult.text }),
            ...(textResult.truncated ? { textTruncated: true } : {}),
            ...(textResult.unavailable ? { textUnavailable: true } : {}),
          })
        }
        return {
          path,
          book,
          pageNumbers: resolved.mode,
          printedOffset: resolved.printedOffset,
          textIncluded: includeText,
          imageTokens: 0,
          pages,
        }
      }
      const requestedScale =
        args.scale ?? (args.image_quality === 'cheap' ? 1.5 : config.defaultScale)
      const scale = normalizeScale(requestedScale, config.defaultScale)
      const crop = parseCrop(args.crop)
      let rendered
      try {
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
      const pages = []
      let totalImageTokens = 0
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
        if (typeof ref?.attachmentId !== 'string') {
          throw codedError(`attachment store returned no reference for PDF page ${pdf}`, 'PDF_READER_ATTACHMENT_FAILED')
        }
        const pageTokens = estimateImageTokens(
          ref?.width ?? page.width ?? 0,
          ref?.height ?? page.height ?? 0,
        ).numTokens
        totalImageTokens += pageTokens
        pages.push({
          pdf,
          tokens: pageTokens,
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
      if (config.debugCost === true) {
        try {
          appendFileSync(
            new URL('../.debug-cost.log', import.meta.url).pathname,
            JSON.stringify({
              at: new Date().toISOString(),
              tool: 'pdf_read_pages',
              book: titleFromPath(path),
              pages: pages.map((page) => ({ pdf: page.pdf, printed: page.printed, tokens: page.tokens })),
              imageTokens: totalImageTokens,
              textTokens: estimateTextTokens(pages.map((page) => page.text ?? '').join('\n')),
              scale: Number.isFinite(scale) ? scale : undefined,
            }) + '\n',
          )
        } catch {}
      }
      return {
        path,
        book,
        pageNumbers: resolved.mode,
        printedOffset: resolved.printedOffset,
        textIncluded: includeText,
        imageTokens: totalImageTokens,
        pages,
      }
      } catch (error) {
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
  const views = createViewStateAdapter()

  const routeHandler = createRouteHandler({
    config,
    pdfCore: core,
    infoCache,
    positions,
    statFile: stat,
    views,
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

  if (config.rememberView) {
    ctx.inject(['storageDomain'], (storageCtx) => {
      let disposed = false
      let domain = null

      async function closeDomain() {
        const handle = domain
        domain = null
        if (handle === null) return
        try {
          await handle.close()
        } catch (error) {
          views.warnOnce('remembered page/zoom storage did not close cleanly', error)
        }
      }

      // Opening is asynchronous while the route is already answering: the
      // adapter stays unavailable until attach(), and reverts to unavailable
      // on unload. Every failure leaves the feature disabled, never thrown.
      const opening = (async () => {
        try {
          domain = await openViewStateDomain(storageCtx.storageDomain)
        } catch (error) {
          views.warnOnce('remembered page/zoom storage is unavailable', error)
          return
        }
        if (disposed) {
          await closeDomain()
          return
        }
        try {
          views.attach(domain.table(VIEW_TABLE_NAME))
        } catch (error) {
          views.warnOnce('remembered page/zoom storage is unavailable', error)
          await closeDomain()
        }
      })()

      return async () => {
        disposed = true
        views.detach()
        await opening
        await closeDomain()
      }
    })
  }

  if (config.autoShare) {
    const listener = createAutoShareListener({ config, positions, infoCache })
    ctx.on('agent/pre-step', listener, { prepend: true })
  }
}
