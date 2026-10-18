/**
 * Host-half tests for dsh-pdf-reader.
 *
 * Plain `node`, no framework, no running harness. The three host-provided
 * bare specifiers are replaced with data-URL stubs through Node's synchronous
 * module hooks, so the real `lib/index.js` is imported and exercised:
 * page-selection parsing, printed/PDF mode resolution, section trails, the
 * auto-share message and throttle decision, route hardening, the route
 * handler, tool registration, and the image-bearing read-pages tool.
 */

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const STUBS = {
  '@deepseek-ai/schemastery': `
    const node = () => ({ default: () => node() })
    const z = {
      boolean: node,
      number: node,
      object: (shape) => ({
        shape,
        type: 'object',
        meta: {},
        [Symbol.for('schemastery')]: true,
        '~standard': { validate: (value) => ({ value }) },
      }),
    }
    export default z
  `,
  '@deepseek-ai/dsh-tools': `export function defineTool(definition) { return definition }`,
  '@deepseek-ai/dsh-llm': `
    export function createUserMessage(input) {
      return { ...input, role: 'user', id: 'test-message' }
    }
  `,
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = STUBS[specifier]
    if (source !== undefined) {
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const host = await import('../lib/index.js')

const PDF = '/books/Linear Algebra Done Right.pdf'
const PDF_STAT = { isFile: () => true, size: 1234, mtimeMs: 42 }
const INFO = {
  path: PDF,
  pageCount: 410,
  printedOffset: 20,
  labels: [
    { pdf: 21, printed: 1 },
    { pdf: 22, printed: 2 },
    { pdf: 152, printed: 132 },
  ],
  outline: [
    { title: 'Chapter 5 Eigenvalues and Eigenvectors', pdf: 100, printed: 80, depth: 0 },
    { title: '5A Invariant Subspaces', pdf: 110, printed: 90, depth: 1 },
    { title: '5A.1 Eigenvalues', pdf: 112, printed: 92, depth: 2 },
    { title: '5B The Minimal Polynomial', pdf: 150, printed: 130, depth: 1 },
  ],
}

let passed = 0
let failed = 0

async function test(name, body) {
  try {
    await body()
    passed += 1
    process.stdout.write(`ok - ${name}\n`)
  } catch (error) {
    failed += 1
    process.stdout.write(`not ok - ${name}\n`)
    process.stdout.write(`${error?.stack ?? String(error)}\n`)
  }
}

function assertRejectsCode(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`)
    return true
  })
}

function makeStatFile(files) {
  return async function statFile(path) {
    const entry = files.get(path)
    if (entry === undefined) {
      const error = new Error(`ENOENT: ${path}`)
      error.code = 'ENOENT'
      throw error
    }
    return entry
  }
}

class FakeResponse {
  constructor() {
    this.status = 0
    this.headers = {}
    this.body = ''
    this.headersSent = false
    this.ended = false
  }

  writeHead(status, headers) {
    this.status = status
    this.headers = headers
    this.headersSent = true
  }

  end(body = '') {
    this.body = body
    this.ended = true
  }

  json() {
    return JSON.parse(this.body)
  }
}

function makeRequest({ method = 'GET', url, headers = {}, body, contentType = 'application/json' } = {}) {
  const request = {
    method,
    url,
    headers: {
      host: '127.0.0.1:49224',
      ...(body === undefined ? {} : { 'content-type': contentType }),
      ...headers,
    },
  }
  if (body !== undefined) {
    request[Symbol.asyncIterator] = async function* iterator() {
      yield Buffer.from(body)
    }
  }
  return request
}

async function callRoute(handler, options) {
  const response = new FakeResponse()
  await handler(makeRequest(options), response)
  return response
}

async function makeRouteFixture(overrides = {}) {
  const config = host.normalizeConfig(overrides.config)
  const files = new Map([[PDF, PDF_STAT]])
  const statFile = overrides.statFile ?? makeStatFile(files)
  const infoCache =
    overrides.infoCache ??
    host.createInfoCache({
      getInfo: async () => INFO,
      statFile,
      limit: config.infoCacheSize,
    })
  const positions = overrides.positions ?? host.createPositionStore()
  const calls = []
  const pdfCore = {
    async searchPdf(path, query, options) {
      calls.push({ path, query, options })
      return {
        hits: [
          { pdf: 152, printed: 132, indexOnPage: 0, snippet: 'singular value decomposition' },
          { pdf: 153, printed: 133, indexOnPage: 2, snippet: 'SVD' },
        ],
      }
    },
    async getInfo(path) {
      return INFO
    },
  }
  const handler = host.createRouteHandler({
    config,
    pdfCore,
    infoCache,
    positions,
    statFile,
  })
  return { handler, config, positions, infoCache, calls, files }
}

function query(path, params = {}) {
  const url = new URL(`http://127.0.0.1${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return `${url.pathname}${url.search}`
}

// ---------------------------------------------------------------------------
// Plugin shape
// ---------------------------------------------------------------------------

await test('exports the Cordis plugin shape', () => {
  assert.equal(host.name, 'pdf-reader')
  assert.deepEqual(host.inject, ['tools', 'webServer', 'agents'])
  assert.equal(host.ROUTE_PATH, '/dsh-pdf-reader')
  assert.equal(typeof host.apply, 'function')
  assert.equal(typeof host.Config, 'object')
})

// ---------------------------------------------------------------------------
// Route hardening primitives
// ---------------------------------------------------------------------------

await test('loopbackHost accepts only loopback names', () => {
  assert.equal(host.loopbackHost('127.0.0.1:49224'), true)
  assert.equal(host.loopbackHost('localhost:3000'), true)
  assert.equal(host.loopbackHost('LOCALHOST'), true)
  assert.equal(host.loopbackHost('[::1]:49224'), true)
  assert.equal(host.loopbackHost('::1'), true)
  assert.equal(host.loopbackHost('127.0.0.1.evil.example'), false)
  assert.equal(host.loopbackHost('evil.example'), false)
  assert.equal(host.loopbackHost('[::1'), false)
  assert.equal(host.loopbackHost(''), false)
  assert.equal(host.loopbackHost(undefined), false)
})

await test('validateRouteTarget rejects relative, non-PDF, missing, directory, oversized, and accepts a real .pdf', async () => {
  const files = new Map([
    [PDF, PDF_STAT],
    ['/tmp/dir.pdf', { isFile: () => false, size: 10, mtimeMs: 1 }],
    ['/tmp/big.pdf', { isFile: () => true, size: 99, mtimeMs: 1 }],
  ])
  const statFile = makeStatFile(files)
  const options = { statFile, maxFileBytes: 50 }

  assert.deepEqual(await host.validateRouteTarget('relative.pdf', options), {
    ok: false,
    status: 400,
    error: 'invalid-path',
  })
  assert.deepEqual(await host.validateRouteTarget('/tmp/notes.txt', options), {
    ok: false,
    status: 400,
    error: 'invalid-path',
  })
  assert.deepEqual(await host.validateRouteTarget('/tmp/missing.pdf', options), {
    ok: false,
    status: 404,
    error: 'missing',
  })
  assert.deepEqual(await host.validateRouteTarget('/tmp/dir.pdf', options), {
    ok: false,
    status: 400,
    error: 'not-a-file',
  })
  assert.deepEqual(await host.validateRouteTarget('/tmp/big.pdf', options), {
    ok: false,
    status: 413,
    error: 'file-too-large',
  })
  const accepted = await host.validateRouteTarget(PDF, { statFile, maxFileBytes: 5000 })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.path, PDF)
  assert.equal(accepted.stat, PDF_STAT)
})

// ---------------------------------------------------------------------------
// Page selection and page-number modes
// ---------------------------------------------------------------------------

await test('parsePageSelection accepts ranges, lists, arrays, unicode dashes, and deduplicates', () => {
  assert.deepEqual(host.parsePageSelection('132-134'), [132, 133, 134])
  assert.deepEqual(host.parsePageSelection('132,135'), [132, 135])
  assert.deepEqual(host.parsePageSelection('132-134,137'), [132, 133, 134, 137])
  assert.deepEqual(host.parsePageSelection([132, 133, 134]), [132, 133, 134])
  assert.deepEqual(host.parsePageSelection(['132-134', '137']), [132, 133, 134, 137])
  assert.deepEqual(host.parsePageSelection('3,1,3'), [1, 3])
  assert.deepEqual(host.parsePageSelection('132\u2013134'), [132, 133, 134])
  assert.deepEqual(host.parsePageSelection(' 132 , 135 '), [132, 135])
})

await test('parsePageSelection rejects malformed, reversed, empty, fractional, and oversized selections', async () => {
  assert.throws(() => host.parsePageSelection('abc'), /cannot parse/u)
  assert.throws(() => host.parsePageSelection('0'), /positive integers/u)
  assert.throws(() => host.parsePageSelection('-1'), /cannot parse/u)
  assert.throws(() => host.parsePageSelection('134-132'), /starts after it ends/u)
  assert.throws(() => host.parsePageSelection(''), /at least one/u)
  assert.throws(() => host.parsePageSelection([]), /at least one/u)
  assert.throws(() => host.parsePageSelection([1.5]), /positive integers/u)
  assert.throws(() => host.parsePageSelection('1-300'), /too large to expand/u)
  await assertRejectsCode(
    Promise.resolve().then(() => host.parsePageSelection('1-5', { maxPages: 4 })),
    'PDF_READER_TOO_MANY_PAGES',
  )
  await assertRejectsCode(
    Promise.resolve().then(() => host.parsePageSelection('1-5', { maxPages: 8, hardLimit: 4 })),
    'PDF_READER_TOO_MANY_PAGES',
  )
})

await test('parseCrop accepts fractions in string, array, and object form', () => {
  assert.deepEqual(host.parseCrop('0,0,1,0.55'), { x: 0, y: 0, w: 1, h: 0.55 })
  assert.deepEqual(host.parseCrop([0, 0.45, 1, 1]), { x: 0, y: 0.45, w: 1, h: 0.55 })
  assert.deepEqual(host.parseCrop({ x: 0.1, y: 0.2, w: 0.5, h: 0.5 }), {
    x: 0.1,
    y: 0.2,
    w: 0.5,
    h: 0.5,
  })
  assert.equal(host.parseCrop(undefined), undefined)
  assert.throws(() => host.parseCrop('0,0,0.5'), /exactly four/u)
  assert.throws(() => host.parseCrop('0,0,1.2,1'), /crop must satisfy/u)
  assert.throws(() => host.parseCrop('0.6,0,0.5,1'), /crop must satisfy/u)
  assert.throws(() => host.parseCrop([0, 0, 'x', 1]), /finite numbers/u)
  assert.throws(() => host.parseCrop({ x: 0, y: 0, w: 0, h: 1 }), /w,h > 0/u)
  assert.throws(() => host.parseCrop({ x: 0.6, y: 0, w: 0.5, h: 1 }), /x\+w <= 1/u)
  assert.throws(() => host.parseCrop({ x: 0, y: 0, w: '0.5', h: 1 }), /finite numeric/u)
})

await test('detectPageMode and resolveRequestedPages translate printed numbers to PDF pages', () => {
  const detected = host.detectPageMode(INFO)
  assert.equal(detected.detectable, true)
  assert.equal(detected.offset, 20)

  const printed = host.resolveRequestedPages({ selection: '132-133', info: INFO, maxPages: 4 })
  assert.deepEqual(printed.pdfPages, [152, 153])
  assert.equal(printed.mode, 'printed')
  assert.equal(printed.printedOffset, 20)

  const pdf = host.resolveRequestedPages({ selection: [152], pageNumbers: 'pdf', info: INFO })
  assert.deepEqual(pdf.pdfPages, [152])
  assert.equal(pdf.mode, 'pdf')

  const noLabels = { pageCount: 20, printedOffset: 0, labels: [] }
  assert.equal(host.detectPageMode(noLabels).detectable, false)
  const fallback = host.resolveRequestedPages({ selection: '3', info: noLabels })
  assert.deepEqual(fallback.pdfPages, [3])
  assert.equal(fallback.mode, 'pdf')
  assert.throws(
    () => host.resolveRequestedPages({ selection: '3', pageNumbers: 'printed', info: noLabels }),
    /no numeric printed-page labels/u,
  )
})

await test('resolveRequestedPages rejects out-of-range pages and too many pages', async () => {
  assert.throws(
    () => host.resolveRequestedPages({ selection: '395', info: INFO }),
    /outside this document \(410 pages\)/u,
  )
  await assertRejectsCode(
    Promise.resolve().then(() => host.resolveRequestedPages({ selection: '1-5', info: INFO, maxPages: 4 })),
    'PDF_READER_TOO_MANY_PAGES',
  )
  await assertRejectsCode(
    Promise.resolve().then(() => host.resolveRequestedPages({ selection: '9999', info: INFO })),
    'PDF_READER_INVALID_PAGE',
  )
  assert.throws(
    () =>
      host.resolveRequestedPages({
        selection: '1',
        info: { pageCount: 0, printedOffset: -5, labels: [{ pdf: 1, printed: 1 }] },
      }),
    /before the first page/u,
  )
})

// ---------------------------------------------------------------------------
// Outline sections and auto-share text
// ---------------------------------------------------------------------------

await test('sectionTrailForPage returns the containing chapter/section chain', () => {
  const trail115 = host.sectionTrailForPage(INFO.outline, 115)
  assert.deepEqual(
    trail115.map((entry) => entry.title),
    ['Chapter 5 Eigenvalues and Eigenvectors', '5A Invariant Subspaces', '5A.1 Eigenvalues'],
  )
  const trail155 = host.sectionTrailForPage(INFO.outline, 155)
  assert.deepEqual(trail155.map((entry) => entry.title), [
    'Chapter 5 Eigenvalues and Eigenvectors',
    '5B The Minimal Polynomial',
  ])
  assert.deepEqual(host.sectionTrailForPage(INFO.outline, 50), [])
  assert.deepEqual(
    host.sectionTrailForPage(INFO.outline, 100).map((entry) => entry.title),
    ['Chapter 5 Eigenvalues and Eigenvectors'],
  )
})

await test('sanitizeOutline caps entries and reports truncation', () => {
  const long = Array.from({ length: 5 }, (_, index) => ({
    title: `S${index}`,
    pdf: index + 1,
    printed: index + 1,
    depth: 0,
  }))
  const sanitized = host.sanitizeOutline(long, 2)
  assert.equal(sanitized.outline.length, 2)
  assert.equal(sanitized.truncated, true)
  assert.equal(host.sanitizeOutline(undefined, 2).outline.length, 0)
})

await test('renderReadingContext renders a source-attributed printed/PDF message with the section', () => {
  const trail = host.sectionTrailForPage(INFO.outline, 152)
  const text = host.renderReadingContext({
    path: PDF,
    pdfPage: 152,
    printedPage: 132,
    title: 'LADR',
    sectionTrail: trail,
  })
  assert.match(text, /^\[dsh-pdf-reader\] The user is reading "LADR" at printed page 132 \(PDF 152\)/u)
  assert.match(text, /5B The Minimal Polynomial/u)
  assert.match(text, /call pdf_read_pages with path:"\/books\/Linear Algebra Done Right\.pdf" and pages:"132"/u)
  assert.match(text, /当前页/u)
  assert.equal(text.split('\n').length, 2)
})

await test('renderReadingContext falls back to a PDF page number with page_numbers:"pdf"', () => {
  const text = host.renderReadingContext({ path: '/tmp/book.pdf', pdfPage: 7 })
  assert.match(text, /reading "book" at PDF page 7/u)
  assert.match(text, /pages:"7", page_numbers:"pdf"/u)
})

await test('printedPageFor prefers reported labels, then the label map, then the body offset', () => {
  assert.equal(host.printedPageFor(INFO, 152), 132)
  assert.equal(host.printedPageFor(INFO, 152, '132'), '132')
  assert.equal(host.printedPageFor(INFO, 5), null)
  const front = {
    pageCount: 30,
    printedOffset: 20,
    labels: [
      { pdf: 1, printed: 'i' },
      { pdf: 5, printed: 'v' },
      { pdf: 21, printed: 1 },
    ],
    outline: [],
  }
  assert.equal(host.printedPageFor(front, 5), 'v')
  assert.equal(host.printedPageFor(front, 6), null)
  assert.equal(host.printedPageFor(front, 22), 2)
  assert.equal(host.printedPageFor(null, 22), null)
})

await test('a roman printed label appears in prose but the hint falls back to the PDF page', () => {
  const text = host.renderReadingContext({ path: '/tmp/book.pdf', pdfPage: 5, printedPage: 'v' })
  assert.match(text, /at printed page v \(PDF 5\)/u)
  assert.match(text, /pages:"5", page_numbers:"pdf"/u)
  assert.doesNotMatch(text, /pages:"v"/u)
})

await test('trimPageText collapses noise, caps, and reports unavailable text', () => {
  assert.deepEqual(host.trimPageText('a\r\n\r\n\r\nb   \n', 100), {
    text: 'a\n\nb',
    truncated: false,
    unavailable: false,
  })
  const capped = host.trimPageText('x'.repeat(50), 10)
  assert.equal(capped.text.length, 10)
  assert.equal(capped.truncated, true)
  assert.deepEqual(host.trimPageText('   \n\n ', 100), {
    text: undefined,
    truncated: false,
    unavailable: true,
  })
  assert.equal(host.trimPageText(undefined, 100).unavailable, true)
})

// ---------------------------------------------------------------------------
// Auto-share throttling
// ---------------------------------------------------------------------------

const POSITION = {
  path: PDF,
  pdfPage: 152,
  printedPage: 132,
  printedOffset: null,
  sessionId: 's1',
  updatedAt: 1_000,
}

const stateAfter = (now = 1_000, turn = 1, step = 1) => ({
  lastInjectedPath: PDF,
  lastInjectedPdfPage: 152,
  lastInjectedAt: now,
  lastInjectedTurn: turn,
  lastInjectedStep: step,
})

await test('decideAutoShare injects once, then only on a changed page after the interval', () => {
  const config = host.normalizeConfig({ autoShareMinIntervalMs: 180_000 })
  const first = host.decideAutoShare({ position: POSITION, now: 1_000, turn: 1, step: 1, config })
  assert.equal(first.inject, true)
  assert.deepEqual(first.nextState, stateAfter(1_000))

  const same = host.decideAutoShare({ position: POSITION, state: first.nextState, now: 500_000, turn: 1, step: 3, config })
  assert.equal(same.inject, false)
  assert.equal(same.reason, 'unchanged')

  const tooSoon = host.decideAutoShare({
    position: { ...POSITION, pdfPage: 153, printedPage: 133 },
    state: first.nextState,
    now: 100_000,
    turn: 1,
    step: 3,
    config,
  })
  assert.equal(tooSoon.inject, false)
  assert.equal(tooSoon.reason, 'throttled')
  assert.equal(tooSoon.nextState, first.nextState)

  const later = host.decideAutoShare({
    position: { ...POSITION, pdfPage: 153, printedPage: 133 },
    state: first.nextState,
    now: 181_000,
    turn: 1,
    step: 3,
    config,
  })
  assert.equal(later.inject, true)
  assert.equal(later.nextState.lastInjectedPdfPage, 153)
})

await test('decideAutoShare refuses a second injection in the same step', () => {
  const config = host.normalizeConfig({ autoShareMinIntervalMs: 0, autoShareMinSteps: 1 })
  const state = stateAfter(1_000)
  const verdict = host.decideAutoShare({
    position: { ...POSITION, pdfPage: 153 },
    state,
    now: 2_000,
    turn: 1,
    step: 1,
    config,
  })
  assert.equal(verdict.inject, false)
  assert.equal(verdict.reason, 'same-step')
})

await test('decideAutoShare honors autoShareMinSteps', () => {
  const config = host.normalizeConfig({ autoShareMinIntervalMs: 0, autoShareMinSteps: 3 })
  const state = stateAfter(1_000, 2, 1)
  const near = host.decideAutoShare({
    position: { ...POSITION, pdfPage: 153 },
    state,
    now: 2_000,
    turn: 2,
    step: 2,
    config,
  })
  assert.equal(near.inject, false)
  assert.equal(near.reason, 'too-few-steps')
  const far = host.decideAutoShare({
    position: { ...POSITION, pdfPage: 153 },
    state,
    now: 2_000,
    turn: 2,
    step: 4,
    config,
  })
  assert.equal(far.inject, true)
})

await test('decideAutoShare honors page delta, path changes, stale positions, and disable', () => {
  const config = host.normalizeConfig({ autoShareMinIntervalMs: 0, autoSharePageDelta: 3 })
  const state = stateAfter(1_000)
  const near = host.decideAutoShare({
    position: { ...POSITION, pdfPage: 154 },
    state,
    now: 2_000,
    turn: 2,
    step: 1,
    config,
  })
  assert.equal(near.inject, false)
  assert.equal(near.reason, 'page-delta')
  const far = host.decideAutoShare({
    position: { ...POSITION, pdfPage: 156 },
    state,
    now: 2_000,
    turn: 2,
    step: 1,
    config,
  })
  assert.equal(far.inject, true)

  const otherBook = host.decideAutoShare({
    position: { ...POSITION, path: '/books/other.pdf', pdfPage: 1 },
    state,
    now: 2_000,
    turn: 2,
    step: 1,
    config,
  })
  assert.equal(otherBook.inject, true)

  const stale = host.decideAutoShare({
    position: POSITION,
    now: 100_000,
    turn: 2,
    step: 1,
    config: host.normalizeConfig({ autoShareMaxAgeMs: 1_000 }),
  })
  assert.equal(stale.inject, false)
  assert.equal(stale.reason, 'stale')

  const disabled = host.decideAutoShare({
    position: POSITION,
    now: 1_000,
    turn: 2,
    step: 1,
    config: host.normalizeConfig({ autoShare: false }),
  })
  assert.equal(disabled.inject, false)
  assert.equal(disabled.reason, 'disabled')
})

await test('createAutoShareListener appends exactly one source-attributed message per changed page', async () => {
  const config = host.normalizeConfig({ autoShareMinIntervalMs: 0 })
  const positions = host.createPositionStore()
  const infoCache = host.createInfoCache({
    getInfo: async () => INFO,
    statFile: async () => PDF_STAT,
  })
  let clock = 1_000
  const listener = host.createAutoShareListener({
    config,
    positions,
    infoCache,
    now: () => clock,
    createMessage: (input) => ({ ...input, id: 'm', role: 'user' }),
  })
  positions.record({ path: PDF, pdfPage: 152, printedPage: 132, sessionId: 's1' })

  const payload = {
    agent: { session: { id: 's1' } },
    turn: 1,
    step: 1,
    signal: { aborted: false },
  }
  const decision = { kind: 'accept', messages: [] }
  const first = await listener(payload, async () => decision)
  assert.equal(first.messages.length, 1)
  assert.equal(first.messages[0].role, 'user')
  assert.equal(first.messages[0].source.kind, 'pdf-reader')
  assert.equal(first.messages[0].source.form, 'snapshot')
  assert.match(first.messages[0].content[0].text, /printed page 132 \(PDF 152\)/u)
  assert.match(first.messages[0].content[0].text, /Chapter 5 Eigenvalues and Eigenvectors/u)
  assert.equal(first.kind, 'accept')

  clock = 2_000
  const again = await listener({ ...payload, step: 2 }, async () => ({ kind: 'accept', messages: [] }))
  assert.equal(again.messages.length, 0)

  clock = 3_000
  positions.record({ path: PDF, pdfPage: 153, printedPage: 133, sessionId: 's1' })
  const moved = await listener({ ...payload, step: 3 }, async () => ({ kind: 'accept', messages: [] }))
  assert.equal(moved.messages.length, 1)
  assert.match(moved.messages[0].content[0].text, /printed page 133 \(PDF 153\)/u)

  const otherSession = await listener(
    { ...payload, agent: { session: { id: 's2' } } },
    async () => ({ kind: 'accept', messages: [] }),
  )
  assert.equal(otherSession.messages.length, 0)
})

await test('createAutoShareListener never injects for a position from another session', async () => {
  const config = host.normalizeConfig({ autoShareMinIntervalMs: 0 })
  const positions = host.createPositionStore()
  positions.record({ path: PDF, pdfPage: 152, sessionId: 'other' })
  const listener = host.createAutoShareListener({
    config,
    positions,
    now: () => 1_000,
    createMessage: (input) => input,
  })
  const decision = { kind: 'accept', messages: [] }
  const result = await listener(
    { agent: { session: { id: 'mine' } }, turn: 1, step: 1, signal: { aborted: false } },
    async () => decision,
  )
  assert.equal(result, decision)
  assert.equal(result.messages.length, 0)
})

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

await test('normalizeConfig applies defaults and rejects out-of-range values', () => {
  assert.deepEqual(host.normalizeConfig(), host.DEFAULT_CONFIG)
  assert.equal(host.normalizeConfig({ autoShare: false }).autoShare, false)
  assert.equal(host.normalizeConfig({ maxPagesPerCall: 8 }).maxPagesPerCall, 8)
  assert.throws(() => host.normalizeConfig({ maxPagesPerCall: 9 }), /between 1 and 8/u)
  assert.throws(() => host.normalizeConfig({ maxPagesPerCall: 0 }), /between 1 and 8/u)
  assert.throws(() => host.normalizeConfig({ autoShareMinIntervalMs: -1 }), /between 0 and 86400000/u)
  assert.throws(() => host.normalizeConfig({ autoShare: 'yes' }), /must be a boolean/u)
  assert.throws(() => host.normalizeConfig({ defaultScale: 0.5 }), /between 1 and 3/u)
  assert.throws(() => host.normalizeConfig({ defaultScale: 9 }), /between 1 and 3/u)
})

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

await test('GET /info returns the outline/offset and never adds a CORS header', async () => {
  const { handler } = await makeRouteFixture()
  const response = await callRoute(handler, {
    url: query('/dsh-pdf-reader/info', { path: PDF }),
  })
  assert.equal(response.status, 200)
  const payload = response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.path, PDF)
  assert.equal(payload.pageCount, 410)
  assert.equal(payload.printedOffset, 20)
  assert.equal(payload.outline.length, 4)
  assert.equal(payload.outline[0].title, 'Chapter 5 Eigenvalues and Eigenvectors')
  assert.equal(payload.labels.length, 3)
  assert.equal(response.headers['access-control-allow-origin'], undefined)
  assert.match(response.headers['content-type'], /application\/json/u)
})

await test('routes reject a non-loopback Host and wrong methods', async () => {
  const { handler } = await makeRouteFixture()
  const forbidden = await callRoute(handler, {
    url: query('/dsh-pdf-reader/info', { path: PDF }),
    headers: { host: 'evil.example' },
  })
  assert.equal(forbidden.status, 403)
  assert.deepEqual(forbidden.json(), { ok: false, error: 'forbidden-host' })

  const wrongMethod = await callRoute(handler, {
    method: 'POST',
    url: query('/dsh-pdf-reader/info', { path: PDF }),
  })
  assert.equal(wrongMethod.status, 405)
  assert.deepEqual(wrongMethod.json(), { ok: false, error: 'method-not-allowed' })

  const unknown = await callRoute(handler, { url: '/dsh-pdf-reader/nope' })
  assert.equal(unknown.status, 404)

  const unrelated = await callRoute(handler, { url: '/some-other-plugin/info' })
  assert.equal(unrelated.status, 404)
})

await test('GET /search validates the query and maps/clamps hits', async () => {
  const fixture = await makeRouteFixture()
  const missing = await callRoute(fixture.handler, {
    url: query('/dsh-pdf-reader/search', { path: PDF }),
  })
  assert.equal(missing.status, 400)
  assert.deepEqual(missing.json(), { ok: false, error: 'missing-query' })

  const response = await callRoute(fixture.handler, {
    url: query('/dsh-pdf-reader/search', {
      path: PDF,
      q: 'singular value',
      ignoreCase: '1',
      limit: '500',
    }),
  })
  assert.equal(response.status, 200)
  const payload = response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.hits.length, 2)
  assert.deepEqual(payload.hits[0], {
    pdf: 152,
    printed: 132,
    snippet: 'singular value decomposition',
  })
  assert.equal(fixture.calls.length, 1)
  assert.deepEqual(fixture.calls[0], {
    path: PDF,
    query: 'singular value',
    options: { ignoreCase: true, limit: fixture.config.maxSearchResults },
  })
})

await test('POST /current stores a session position; GET /current returns it with its section', async () => {
  const { handler, positions } = await makeRouteFixture()
  const post = await callRoute(handler, {
    method: 'POST',
    url: '/dsh-pdf-reader/current',
    body: JSON.stringify({ path: PDF, pdfPage: 152, printedPage: 132, sessionId: 's1' }),
  })
  assert.equal(post.status, 200)
  assert.deepEqual(post.json(), { ok: true })
  assert.equal(positions.forSession('s1').pdfPage, 152)

  const get = await callRoute(handler, {
    url: query('/dsh-pdf-reader/current', { sessionId: 's1' }),
  })
  assert.equal(get.status, 200)
  const payload = get.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.path, PDF)
  assert.equal(payload.pdfPage, 152)
  assert.equal(payload.printedPage, 132)
  assert.equal(payload.section.title, '5B The Minimal Polynomial')
  assert.deepEqual(payload.sectionTrail, [
    'Chapter 5 Eigenvalues and Eigenvectors',
    '5B The Minimal Polynomial',
  ])

  const unknown = await callRoute(handler, {
    url: query('/dsh-pdf-reader/current', { sessionId: 'nobody' }),
  })
  assert.deepEqual(unknown.json(), { ok: true, current: null })
})

await test('POST /current without sessionId stores only a path position, not a session position', async () => {
  const { handler, positions } = await makeRouteFixture()
  const post = await callRoute(handler, {
    method: 'POST',
    url: '/dsh-pdf-reader/current',
    body: JSON.stringify({ path: PDF, pdfPage: 152, printedPage: 132 }),
  })
  assert.equal(post.status, 200)
  assert.equal(positions.sessionCount, 0)
  assert.equal(positions.pathCount, 1)

  const byPath = await callRoute(handler, {
    url: query('/dsh-pdf-reader/current', { path: PDF }),
  })
  assert.equal(byPath.json().pdfPage, 152)
})

await test('POST /current enforces JSON content type, body cap, path, page, and session validation', async () => {
  const { handler } = await makeRouteFixture()

  const wrongType = await callRoute(handler, {
    method: 'POST',
    url: '/dsh-pdf-reader/current',
    body: 'not json',
    contentType: 'text/plain',
  })
  assert.equal(wrongType.status, 415)

  const tooLarge = await callRoute(handler, {
    method: 'POST',
    url: '/dsh-pdf-reader/current',
    body: JSON.stringify({ path: PDF, pdfPage: 1, padding: 'x'.repeat(70_000) }),
  })
  assert.equal(tooLarge.status, 413)

  for (const body of [
    { path: 'relative.pdf', pdfPage: 1 },
    { path: PDF, pdfPage: 0 },
    { path: PDF, pdfPage: 1, sessionId: '' },
    { path: PDF, pdfPage: 1, printedPage: -3 },
  ]) {
    const response = await callRoute(handler, {
      method: 'POST',
      url: '/dsh-pdf-reader/current',
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal(response.json().ok, false)
  }

  const badJson = await callRoute(handler, {
    method: 'POST',
    url: '/dsh-pdf-reader/current',
    body: '{',
  })
  assert.equal(badJson.status, 400)
  assert.deepEqual(badJson.json(), { ok: false, error: 'invalid-json' })
})

await test('GET /info surfaces missing and invalid paths', async () => {
  const { handler } = await makeRouteFixture()
  const missing = await callRoute(handler, {
    url: query('/dsh-pdf-reader/info', { path: '/books/missing.pdf' }),
  })
  assert.equal(missing.status, 404)
  assert.deepEqual(missing.json(), { ok: false, error: 'missing' })

  const invalid = await callRoute(handler, {
    url: query('/dsh-pdf-reader/info', { path: 'relative.pdf' }),
  })
  assert.equal(invalid.status, 400)
  assert.deepEqual(invalid.json(), { ok: false, error: 'invalid-path' })
})

// ---------------------------------------------------------------------------
// Tool registration and image-bearing read tool
// ---------------------------------------------------------------------------

function makeToolContext({ attachments, modalities = ['text', 'image'] } = {}) {
  return {
    get(name) {
      if (name === 'attachments') return attachments
      if (name === 'llm') {
        return {
          async resolveModelInfo() {
            return { inputModalities: modalities }
          },
        }
      }
      return undefined
    },
  }
}

function makeExec(sessionId = 's1') {
  return {
    agent: {
      session: {
        id: sessionId,
        header: { cwd: '/books' },
        requestHeader: () => ({ config: { provider: 'provider', model: 'model' } }),
      },
      options: {},
    },
    signal: undefined,
  }
}

await test('apply registers three cheap tools, one image tool, one route, and the pre-step listener', () => {
  const tools = []
  const routes = []
  const listeners = []
  let injections = 0
  const ctx = {
    tools: { register: (definition) => tools.push(definition) },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
    effect: (factory) => {
      factory()
      return () => {}
    },
    on: (event, listener, options) => {
      listeners.push({ event, listener, options })
      return () => {}
    },
    inject: (deps, callback) => {
      injections += 1
      callback({ tools: ctx.tools, get: ctx.get })
      return () => {}
    },
    get: () => undefined,
  }
  host.apply(ctx, {})
  assert.deepEqual(tools.map((tool) => tool.name), ['pdf_info', 'pdf_search', 'pdf_current_page', 'pdf_read_pages'])
  assert.equal(injections, 1)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/dsh-pdf-reader')
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].event, 'agent/pre-step')
  assert.equal(listeners[0].options.prepend, true)
})

await test('apply honors autoShare:false and enabled:false', () => {
  const build = () => {
    const tools = []
    const listeners = []
    const ctx = {
      tools: { register: (definition) => tools.push(definition) },
      webServer: { register: () => () => {} },
      effect: (factory) => {
        factory()
        return () => {}
      },
      on: (event, listener, options) => listeners.push({ event, listener, options }),
      inject: (deps, callback) => callback({ tools: ctx.tools, get: ctx.get }),
      get: () => undefined,
    }
    return { ctx, tools, listeners }
  }

  const noShare = build()
  host.apply(noShare.ctx, { autoShare: false })
  assert.equal(noShare.tools.length, 4)
  assert.equal(noShare.listeners.length, 0)

  const disabled = build()
  host.apply(disabled.ctx, { enabled: false })
  assert.equal(disabled.tools.length, 0)
  assert.equal(disabled.listeners.length, 0)
})

await test('pdf_read_pages renders printed pages, saves attachments, and emits image blocks', async () => {
  const saved = []
  const attachments = {
    async saveImage(input) {
      saved.push(input)
      return {
        attachmentId: `att-${saved.length}`,
        mediaType: 'image/png',
        bytes: input.data.byteLength,
        width: 750,
        height: 1272,
      }
    },
  }
  const renderCalls = []
  const core = {
    async renderPagesToPng(path, pages, options) {
      renderCalls.push({ path, pages, options })
      return pages.map((pdf) => ({
        pdf,
        printed: pdf - 20,
        buffer: Buffer.from(`png-${pdf}`),
        width: 750,
        height: 1272,
      }))
    },
    async getPageText(path, pdf) {
      return `Text for PDF page ${pdf}`
    },
  }
  const statFile = async (path) => {
    assert.equal(path, PDF)
    return PDF_STAT
  }
  const infoCache = host.createInfoCache({ getInfo: async () => INFO, statFile })
  const tool = host.createReadPagesTool({
    defineTool: (definition) => definition,
    ctx: makeToolContext({ attachments }),
    config: host.normalizeConfig({}),
    core,
    infoCache,
    statFile,
  })
  assert.equal(tool.name, 'pdf_read_pages')

  const value = await tool.execute({ path: PDF, pages: '132-133', crop: '0,0,1,0.5', scale: 3 }, makeExec())
  assert.equal(value.book, 'Linear Algebra Done Right')
  assert.equal(value.pageNumbers, 'printed')
  assert.equal(value.printedOffset, 20)
  assert.deepEqual(value.pages.map((page) => page.pdf), [152, 153])
  assert.deepEqual(value.pages.map((page) => page.printed), [132, 133])
  assert.equal(saved.length, 2)
  assert.equal(saved[0].mediaType, 'image/png')
  assert.equal(saved[0].name, 'Linear_Algebra_Done_Right-p152.png')
  assert.deepEqual(renderCalls[0], {
    path: PDF,
    pages: [152, 153],
    options: { scale: 3, crop: { x: 0, y: 0, w: 1, h: 0.5 } },
  })

  const blocks = tool.output.render({}, value)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /<pages mode="printed" printed-offset="20">/u)
  assert.equal(blocks[1].type, 'text')
  assert.match(blocks[1].text, /<page pdf="152" printed="132">/u)
  assert.equal(blocks[2].type, 'image')
  assert.deepEqual(blocks[2].attachment, {
    attachmentId: 'att-1',
    mediaType: 'image/png',
    bytes: 7,
    width: 750,
    height: 1272,
  })
  assert.equal(blocks[3].type, 'text')
  assert.equal(blocks[4].type, 'image')
})

await test('pdf_read_pages maps image_quality:cheap to 1.5x and otherwise uses the 2.5x default', async () => {
  const calls = []
  const build = () =>
    host.createReadPagesTool({
      defineTool: (definition) => definition,
      ctx: makeToolContext({
        attachments: {
          async saveImage({ data, mediaType }) {
            return { attachmentId: 'att', mediaType, bytes: data.byteLength, width: 750, height: 1272 }
          },
        },
      }),
      config: host.normalizeConfig({}),
      core: {
        async renderPagesToPng(path, pages, options) {
          calls.push(options)
          return pages.map((pdf) => ({ pdf, printed: pdf, buffer: Buffer.from('png'), width: 750, height: 1272 }))
        },
        async getPageText() {
          return ''
        },
      },
      infoCache: host.createInfoCache({ getInfo: async () => INFO, statFile: async () => PDF_STAT }),
      statFile: async () => PDF_STAT,
    })

  await build().execute({ path: PDF, pages: '132', image_quality: 'cheap' }, makeExec())
  await build().execute({ path: PDF, pages: '132' }, makeExec())
  assert.equal(calls[0].scale, 1.5)
  assert.equal(calls[1].scale, 2.5)
})

await test('pdf_read_pages enforces the per-call cap before rendering', async () => {
  let rendered = false
  const tool = host.createReadPagesTool({
    defineTool: (definition) => definition,
    ctx: makeToolContext({
      attachments: { async saveImage() { throw new Error('must not be called') } },
    }),
    config: host.normalizeConfig({ maxPagesPerCall: 2 }),
    core: {
      async renderPagesToPng() {
        rendered = true
        return []
      },
      async getPageText() {
        return ''
      },
    },
    infoCache: host.createInfoCache({ getInfo: async () => INFO, statFile: async () => PDF_STAT }),
    statFile: async () => PDF_STAT,
  })
  await assertRejectsCode(
    tool.execute({ path: PDF, pages: '1-3' }, makeExec()),
    'PDF_READER_TOO_MANY_PAGES',
  )
  assert.equal(rendered, false)
})

await test('pdf_read_pages refuses a text-only model route before rendering', async () => {
  let rendered = false
  const tool = host.createReadPagesTool({
    defineTool: (definition) => definition,
    ctx: makeToolContext({
      attachments: { async saveImage() { throw new Error('must not be called') } },
      modalities: ['text'],
    }),
    config: host.normalizeConfig({}),
    core: {
      async renderPagesToPng() {
        rendered = true
        return []
      },
      async getPageText() {
        return ''
      },
    },
    infoCache: host.createInfoCache({ getInfo: async () => INFO, statFile: async () => PDF_STAT }),
    statFile: async () => PDF_STAT,
  })
  await assertRejectsCode(tool.execute({ path: PDF, pages: '132' }, makeExec()), 'PDF_READER_NO_IMAGE_INPUT')
  assert.equal(rendered, false)
})

await test('resolveToolPath resolves relative paths against the session cwd and rejects missing cwd', () => {
  assert.equal(host.resolveToolPath('/books/a.pdf', makeExec()), '/books/a.pdf')
  assert.equal(host.resolveToolPath('a.pdf', makeExec()), '/books/a.pdf')
  assert.throws(() => host.resolveToolPath('a.pdf', { agent: { session: { header: {} } } }), /must be absolute/u)
  assert.throws(() => host.resolveToolPath('   ', makeExec()), /non-empty string/u)
})

await test('pdf_read_pages maps attachment size failures to a crop/downscale hint', async () => {
  const tool = host.createReadPagesTool({
    defineTool: (definition) => definition,
    ctx: makeToolContext({
      attachments: {
        async saveImage() {
          const error = new Error('image exceeds the byte limit')
          error.code = 'IMAGE_TOO_LARGE'
          throw error
        },
      },
    }),
    config: host.normalizeConfig({}),
    core: {
      async renderPagesToPng(path, pages) {
        return pages.map((pdf) => ({ pdf, printed: pdf, buffer: Buffer.from('png'), width: 750, height: 1272 }))
      },
      async getPageText() {
        return ''
      },
    },
    infoCache: host.createInfoCache({ getInfo: async () => INFO, statFile: async () => PDF_STAT }),
    statFile: async () => PDF_STAT,
  })
  await assertRejectsCode(
    tool.execute({ path: PDF, pages: '132' }, makeExec()),
    'PDF_READER_IMAGE_TOO_LARGE',
  )
})

await test('pdf_search defaults to ignore-case and caps the limit', async () => {
  const calls = []
  const core = {
    async searchPdf(path, query, options) {
      calls.push({ path, query, options })
      return { hits: [{ pdf: 10, printed: null, indexOnPage: 1, snippet: 'x' }], pages: 7 }
    },
  }
  const tool = host.createCheapTools({
    defineTool: (definition) => definition,
    config: host.normalizeConfig({ maxSearchResults: 50 }),
    core,
    infoCache: host.createInfoCache({ getInfo: async () => INFO, statFile: async () => PDF_STAT }),
    positions: host.createPositionStore(),
    statFile: async () => PDF_STAT,
  }).find((definition) => definition.name === 'pdf_search')
  const value = await tool.execute({ path: PDF, query: 'eigenvalue', limit: 500 }, makeExec())
  assert.deepEqual(calls[0].options, { ignoreCase: true, limit: 50 })
  assert.equal(value.pages, 7)
  assert.equal(value.hits[0].snippet, 'x')
})

await test('pdf_current_page reports the session position and its section', async () => {
  const positions = host.createPositionStore()
  positions.record({ path: PDF, pdfPage: 152, printedPage: 132, sessionId: 's1' })
  const tool = host.createCheapTools({
    defineTool: (definition) => definition,
    config: host.normalizeConfig({}),
    core: {},
    infoCache: host.createInfoCache({ getInfo: async () => INFO, statFile: async () => PDF_STAT }),
    positions,
    statFile: async () => PDF_STAT,
  }).find((definition) => definition.name === 'pdf_current_page')

  const value = await tool.execute({}, makeExec('s1'))
  assert.equal(value.current.path, PDF)
  assert.equal(value.current.pdfPage, 152)
  assert.equal(value.current.printedPage, 132)
  assert.equal(value.current.pageNumberMode, 'printed')
  assert.equal(value.current.section.title, '5B The Minimal Polynomial')

  const other = await tool.execute({}, makeExec('s2'))
  assert.deepEqual(other, { current: null, reason: 'no-reading-position' })

  const mismatch = await tool.execute({ path: '/books/other.pdf' }, makeExec('s1'))
  assert.deepEqual(mismatch, { current: null, reason: 'path-mismatch' })
})

// ---------------------------------------------------------------------------

if (failed > 0) {
  process.stdout.write(`\n${failed} test(s) failed, ${passed} passed\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`\nall ${passed} host tests passed\n`)
}
