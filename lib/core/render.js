/**
 * dsh-pdf-reader core / render.js
 *
 * Render PDF pages to PNG in-process with pdf.js + @napi-rs/canvas.  No
 * Swift, no shelling out, no browser.  The host hands the returned Buffer to
 * its attachment service and reports width/height to the model.
 *
 * Why a hand-written PNG encoder?  @napi-rs/canvas encodes RGBA PNGs (PNG
 * color type 6).  The host contract asks for RGB; this encoder reads the
 * canvas pixels once and emits an 8-bit RGB PNG (color type 2) on a white
 * background.  It is also a little smaller and just as fast for text pages.
 */

import { createCanvas } from '@napi-rs/canvas'
import { crc32, deflateSync } from 'node:zlib'
import {
  __acquireDocument,
  __ensureMetadata,
  __normalizePdfPage,
  __releaseDocument,
} from './pdf.js'

const DEFAULT_SCALE = 2
const MIN_SCALE = 1
const MAX_SCALE = 3

/** Render at most two pages at a time; a full-page canvas is several MB. */
const MAX_RENDER_CONCURRENCY = 2

/** Guard against pathological page sizes at scale 3 (~200 MB RGBA). */
const MAX_CANVAS_PIXELS = 50_000_000

/** Per-page render timeout: a hostile PDF must not hang the host forever. */
const RENDER_TIMEOUT_MS = 60_000

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const IDAT_LEVEL = 6

// ---------------------------------------------------------------------------
// Small render semaphore (module-wide, so concurrent single-page requests
// also respect the memory limit)
// ---------------------------------------------------------------------------

let activeRenders = 0
/** @type {Array<() => void>} */
const renderWaiters = []

function acquireRenderSlot() {
  if (activeRenders < MAX_RENDER_CONCURRENCY) {
    activeRenders += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    renderWaiters.push(resolve)
  })
}

function releaseRenderSlot() {
  activeRenders -= 1
  const next = renderWaiters.shift()
  if (next) {
    // Hand the slot directly to the waiter, incrementing before it can resume.
    activeRenders += 1
    next()
  }
}

async function withRenderSlot(fn) {
  await acquireRenderSlot()
  try {
    return await fn()
  } finally {
    releaseRenderSlot()
  }
}

// ---------------------------------------------------------------------------
// Option validation
// ---------------------------------------------------------------------------

function normalizeScale(value) {
  const scale = value === undefined ? DEFAULT_SCALE : value
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < MIN_SCALE || scale > MAX_SCALE) {
    throw new RangeError(
      `renderPageToPng: scale must be a number between ${MIN_SCALE} and ${MAX_SCALE} (got ${String(
        value,
      )})`,
    )
  }
  return scale
}

function normalizeCrop(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('renderPageToPng: crop must be an object {x,y,w,h} of page fractions')
  }

  const x = value.x === undefined ? 0 : value.x
  const y = value.y === undefined ? 0 : value.y
  const w = value.w === undefined ? 1 - x : value.w
  const h = value.h === undefined ? 1 - y : value.h

  for (const [name, number] of [
    ['x', x],
    ['y', y],
    ['w', w],
    ['h', h],
  ]) {
    if (typeof number !== 'number' || !Number.isFinite(number)) {
      throw new TypeError(`renderPageToPng: crop.${name} must be a finite number`)
    }
  }

  const epsilon = 1e-9
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1 + epsilon || y + h > 1 + epsilon) {
    throw new RangeError(
      `renderPageToPng: crop must satisfy x,y >= 0, w,h > 0, x+w <= 1, y+h <= 1 (got ${JSON.stringify(
        { x, y, w, h },
      )})`,
    )
  }

  return { x, y, w, h }
}

function normalizeRenderOptions(options) {
  const opts = options && typeof options === 'object' ? options : {}
  return {
    scale: normalizeScale(opts.scale),
    crop: normalizeCrop(opts.crop),
  }
}

function cropRectInPixels(crop, fullWidth, fullHeight) {
  if (!crop) return { x: 0, y: 0, width: fullWidth, height: fullHeight }

  const left = Math.min(fullWidth - 1, Math.max(0, Math.round(fullWidth * crop.x)))
  const top = Math.min(fullHeight - 1, Math.max(0, Math.round(fullHeight * crop.y)))
  const right = Math.min(fullWidth, Math.max(left + 1, Math.round(fullWidth * (crop.x + crop.w))))
  const bottom = Math.min(
    fullHeight,
    Math.max(top + 1, Math.round(fullHeight * (crop.y + crop.h))),
  )
  return { x: left, y: top, width: right - left, height: bottom - top }
}

// ---------------------------------------------------------------------------
// RGB PNG encoding
// ---------------------------------------------------------------------------

function pngChunk(type, data) {
  const chunk = Buffer.allocUnsafe(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write(type, 4, 'ascii')
  data.copy(chunk, 8)
  const checksum = crc32(chunk.subarray(4, 8 + data.length)) >>> 0
  chunk.writeUInt32BE(checksum, 8 + data.length)
  return chunk
}

/**
 * Encode a canvas sub-rectangle as an 8-bit RGB PNG.
 *
 * @param {import('@napi-rs/canvas').SKRSContext2D} context
 * @returns {Buffer}
 */
function encodeRgbPng(context, x, y, width, height) {
  const { data } = context.getImageData(x, y, width, height) // RGBA
  const rowStride = width * 3
  const raw = Buffer.allocUnsafe(height * (rowStride + 1))

  let out = 0
  let src = 0
  for (let row = 0; row < height; row += 1) {
    raw[out] = 0 // PNG filter: None; white text pages compress well anyway
    out += 1
    for (let column = 0; column < width; column += 1) {
      raw[out] = data[src]
      raw[out + 1] = data[src + 1]
      raw[out + 2] = data[src + 2]
      out += 3
      src += 4 // skip alpha; the canvas was filled opaque white
    }
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // color type: truecolour RGB
  header[10] = 0 // compression
  header[11] = 0 // filter method
  header[12] = 0 // interlace

  const idat = deflateSync(raw, { level: IDAT_LEVEL })

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// Render one page
// ---------------------------------------------------------------------------

async function renderOnePage(doc, meta, pdfPage, scale, crop) {
  const page = await doc.getPage(pdfPage)
  const viewport = page.getViewport({ scale })
  const fullWidth = Math.ceil(viewport.width)
  const fullHeight = Math.ceil(viewport.height)

  if (
    !Number.isFinite(fullWidth) ||
    !Number.isFinite(fullHeight) ||
    fullWidth < 1 ||
    fullHeight < 1
  ) {
    throw new Error(`Page ${pdfPage} has an invalid viewport (${viewport.width}x${viewport.height})`)
  }
  if (fullWidth * fullHeight > MAX_CANVAS_PIXELS) {
    throw new RangeError(
      `Page ${pdfPage} at scale ${scale} would be ${fullWidth}x${fullHeight} ` +
        `(${fullWidth * fullHeight} pixels), above the ${MAX_CANVAS_PIXELS} pixel safety cap`,
    )
  }

  const canvas = createCanvas(fullWidth, fullHeight)
  const context = canvas.getContext('2d')

  // Opaque white background before pdf.js paints anything.
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, fullWidth, fullHeight)

  let renderTimer
  try {
    await Promise.race([
      page.render({
        canvasContext: context,
        viewport,
        background: '#ffffff',
      }).promise,
      new Promise((_resolve, reject) => {
        renderTimer = setTimeout(() => {
          const error = new Error(
            `Page ${pdfPage} took longer than ${RENDER_TIMEOUT_MS} ms to render and was abandoned`,
          )
          error.code = 'PDF_RENDER_TIMEOUT'
          reject(error)
        }, RENDER_TIMEOUT_MS)
        if (typeof renderTimer.unref === 'function') renderTimer.unref()
      }),
    ])
  } finally {
    if (renderTimer !== undefined) clearTimeout(renderTimer)
  }

  // Drop the page's operator list/font objects now that the pixels exist.
  // Without this, rendering dozens of pages retains tens of MB of pdf.js
  // page state for the lifetime of the cached document.  It is safe while
  // another render of the same page is in flight: cleanup() refuses to run
  // until the page's render-task set is empty.
  try {
    page.cleanup()
  } catch {
    // best-effort only
  }

  const rect = cropRectInPixels(crop, fullWidth, fullHeight)
  const buffer = encodeRgbPng(context, rect.x, rect.y, rect.width, rect.height)

  return {
    pdf: pdfPage,
    printed: meta.labels[pdfPage - 1]?.printed ?? null,
    buffer,
    width: rect.width,
    height: rect.height,
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await fn(items[index], index)
    }
  }

  // allSettled: if one page fails, let the other in-flight renders finish
  // before the document is released and destroyed.
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  )
  const failure = settled.find((result) => result.status === 'rejected')
  if (failure) throw failure.reason
  return results
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render one 1-based physical PDF page to an RGB PNG Buffer.
 *
 * @param {string} path
 * @param {number} pdfPage
 * @param {{scale?: number, crop?: {x?:number,y?:number,w?:number,h?:number}}} [options]
 * @returns {Promise<{pdf:number, printed:number|string|null, buffer:Buffer,
 *   width:number, height:number}>}
 */
export async function renderPageToPng(path, pdfPage, options) {
  const [result] = await renderPagesToPng(path, [pdfPage], options)
  return result
}

/**
 * Render several pages, preserving input order, with a small concurrency
 * limit.  `crop` and `scale` apply to every page.
 *
 * @param {string} path
 * @param {number[]|number} pages 1-based physical PDF pages
 * @param {{scale?: number, crop?: {x?:number,y?:number,w?:number,h?:number}}} [options]
 * @returns {Promise<Array<{pdf:number, printed:number|string|null, buffer:Buffer,
 *   width:number, height:number}>>}
 */
export async function renderPagesToPng(path, pages, options) {
  const { scale, crop } = normalizeRenderOptions(options)

  const list = Array.isArray(pages) ? pages.slice() : [pages]
  if (list.length === 0) return []

  const entry = await __acquireDocument(path)
  try {
    const meta = await __ensureMetadata(entry)
    const pageNumbers = list.map((pdfPage) => __normalizePdfPage(pdfPage, entry.doc.numPages))

    return await mapWithConcurrency(pageNumbers, MAX_RENDER_CONCURRENCY, (pdfPage) =>
      withRenderSlot(() => renderOnePage(entry.doc, meta, pdfPage, scale, crop)),
    )
  } finally {
    __releaseDocument(entry)
  }
}
