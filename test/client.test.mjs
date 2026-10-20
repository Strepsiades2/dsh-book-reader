/**
 * Headless checks for dsh-pdf-reader's browser half.
 *
 * The real `lib/client.js` is loaded through a fake
 * `window.__ModuleLoader__.load`, exactly like the page does. The first half
 * checks the module shape, slot registration, and the pure helpers (page
 * numbering, reference payloads, insertion, debounce/throttle). The second
 * half mounts the contribution in jsdom, supplies the official preview's DOM
 * markers and fake rectangles, and drives scroll, jump, search, the
 * Cmd/Ctrl+Shift+F shortcut, reporting, the follow toggle, and unmount.
 *
 * jsdom has no layout engine, so every rectangle and scroll offset is supplied
 * by this file; that is also what makes the assertions deterministic.
 *
 * Run: node dsh-pdf-reader/test/client.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const sibling = join(root, '..', 'dsh-pdf-search', 'package.json')
const requireSibling = createRequire(sibling)
const { JSDOM } = requireSibling('jsdom')

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="preview">
    <div id="header"></div>
    <div data-textpreview-body id="body">
      <div data-document-zoom-frame id="frame" data-document-zoom-mode="fit-width" style="--document-zoom: 1">
        <div data-document-zoom-scrollport id="scrollport">
          <section data-pdf-preview id="pages">
            <div data-pdf-page="1"><div class="placeholder"></div></div>
            <div data-pdf-page="2"><div class="placeholder"></div></div>
            <div data-pdf-page="3"><div class="placeholder"></div></div>
          </section>
        </div>
      </div>
    </div>
  </div>
</body></html>`, { url: 'http://127.0.0.1/', pretendToBeVisual: true })

globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Element = dom.window.Element
globalThis.Node = dom.window.Node
globalThis.MutationObserver = dom.window.MutationObserver
globalThis.KeyboardEvent = dom.window.KeyboardEvent
globalThis.MouseEvent = dom.window.MouseEvent
globalThis.IS_REACT_ACT_ENVIRONMENT = true
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })

// React must see `window` while it initializes, otherwise it takes its
// legacy input-event polyfill path (which calls `attachEvent` in jsdom).
const React = requireSibling('react')
const { createRoot } = requireSibling('react-dom/client')

const { document } = dom.window
const header = document.getElementById('header')
const body = document.getElementById('body')
const zoomFrame = document.getElementById('frame')
const scrollport = document.getElementById('scrollport')

const scroll = { top: 0 }
Object.defineProperty(scrollport, 'scrollTop', {
  configurable: true,
  get: () => scroll.top,
  set: (value) => { scroll.top = value },
})
Object.defineProperty(scrollport, 'scrollLeft', { configurable: true, value: 0, writable: true })
Object.defineProperty(scrollport, 'clientHeight', { configurable: true, value: 800 })
Object.defineProperty(scrollport, 'scrollHeight', { configurable: true, value: 1800 })
Object.defineProperty(body, 'clientHeight', { configurable: true, value: 800 })
Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 800 })
Object.defineProperty(body, 'scrollTop', { configurable: true, value: 0, writable: true })

/** @param top - viewport-space top. @returns a DOMRect-shaped object. */
const rect = (top, height = 600, width = 600) => ({
  top,
  left: 0,
  right: width,
  bottom: top + height,
  width,
  height,
  x: 0,
  y: top,
  toJSON() {},
})

scrollport.getBoundingClientRect = () => rect(100, 800)
body.getBoundingClientRect = () => rect(100, 800)
for (const page of document.querySelectorAll('[data-pdf-page]')) {
  const number = Number(page.getAttribute('data-pdf-page'))
  page.getBoundingClientRect = () => rect(100 + (number - 1) * 600 - scroll.top)
}

// ---------------------------------------------------------------------------
// Load the real bundle through the module-loader factory.
// ---------------------------------------------------------------------------
let row
dom.window.__ModuleLoader__ = {
  load(registered) {
    row = registered
  },
}
new Function(readFileSync(join(root, 'lib/client.js'), 'utf8'))()
assert.equal(row.id, 'dsh-book-reader', 'bundle registers the expected id')
assert.equal(typeof row.factory, 'function', 'factory is a function')

const bundle = row.factory((specifier) => {
  assert.equal(specifier, 'react', 'React is the only external')
  return React
})
assert.equal(typeof bundle.apply, 'function')
assert.deepEqual(bundle.inject, ['slots', 'locale'])

let contribution
let localeActive = 'zh'
const calls = []
const ctx = {
  effect(run) {
    calls.push(['effect'])
    return run()
  },
  locale: {
    getSnapshot: () => ({ active: localeActive }),
  },
  slots: {
    inject(name, run) {
      calls.push(['inject', name])
      return run()
    },
    register(options, component) {
      calls.push(['register', options, component])
      return () => {}
    },
  },
}
bundle.apply(ctx)
assert.deepEqual(calls[0], ['effect'])
assert.deepEqual(calls[1], ['inject', 'sidebar.right.tab.document.actions'])
assert.deepEqual(calls[2], ['register', {
  name: 'sidebar.right.tab.document.actions',
  id: 'pdf-reader-tools',
  order: -6,
}, calls[2][2]])
assert.equal(typeof calls[2][2], 'function')
contribution = { options: calls[2][1], component: calls[2][2] }

const {
  buildSearchReference,
  clampZoomScale,
  createDebouncer,
  createRafThrottle,
  describeSearchFailure,
  displayPage,
  insertComposerText,
  isPdfPath,
  normalizeSnippet,
  normalizeView,
  pageElements,
  parsePageInput,
  pickPage,
  printedPageOf,
  readFrameZoom,
  resolvePane,
  resolveScrollport,
  resolveZoomFrame,
  scrollPageIntoView,
  searchResultLabel,
} = bundle.__test

// ---------------------------------------------------------------------------
// Pure helpers: numbering, parsing, reference payloads, insertion.
// ---------------------------------------------------------------------------
assert.equal(isPdfPath('/tmp/book.pdf'), true)
assert.equal(isPdfPath('/tmp/book.PDF'), true)
assert.equal(isPdfPath('/tmp/notes.md'), false)
assert.equal(isPdfPath(undefined), false)

// The Host convention is physical = printed + offset (LADR: 132 -> 152).
assert.equal(printedPageOf(152, 20), 132)
assert.equal(printedPageOf(21, 20), 1)
assert.equal(printedPageOf(20, 20), undefined, 'front matter has no numeric label')
assert.equal(printedPageOf(5, 0), 5, 'zero offset means printed == physical')
assert.equal(printedPageOf(5, undefined), undefined)
assert.equal(printedPageOf(0, 20), undefined)
assert.equal(displayPage(152, 20), 132)
assert.equal(displayPage(20, 20), 20)
assert.equal(displayPage(152, undefined), 152)

assert.equal(parsePageInput('132', { printedOffset: 20, pageCount: 410 }), 152)
assert.equal(parsePageInput('  p152 ', { printedOffset: 20, pageCount: 410 }), 152)
assert.equal(parsePageInput('PDF 152', { printedOffset: 20, pageCount: 410 }), 152)
assert.equal(parsePageInput('p.152', { printedOffset: 20, pageCount: 410 }), 152)
assert.equal(parsePageInput('#152', { printedOffset: 20, pageCount: 410 }), 152)
assert.equal(parsePageInput('132', { pageCount: 410 }), 132, 'no offset means physical')
assert.equal(parsePageInput('0', { pageCount: 410 }), undefined)
assert.equal(parsePageInput('12.5', { pageCount: 410 }), undefined)
assert.equal(parsePageInput('abc', { pageCount: 410 }), undefined)
assert.equal(parsePageInput('', { pageCount: 410 }), undefined)
assert.equal(parsePageInput('391', { printedOffset: 20, pageCount: 410 }), undefined, 'beyond the book')
assert.equal(parsePageInput('411', { printedOffset: 20, pageCount: 410 }), undefined)
assert.equal(parsePageInput('410', { printedOffset: 20, pageCount: 410 }), undefined, 'printed 410 is not PDF 410')
assert.equal(parsePageInput('410', { printedOffset: 0, pageCount: 410 }), 410)

assert.equal(normalizeSnippet('  the   singular\nvalue  '), 'the singular value')
assert.equal(
  buildSearchReference({ pdf: 152, printed: 132, snippet: '  singular   value\n decomposition ' }),
  'PDF p.132: singular value decomposition',
)
assert.equal(buildSearchReference({ pdf: 10, snippet: '' }), '[PDF p.10]')
assert.equal(searchResultLabel({ pdf: 152, printed: 132 }), 'p.132')
assert.equal(searchResultLabel({ pdf: 152 }), 'p.152')
assert.ok(buildSearchReference({ pdf: 1, snippet: 'x'.repeat(400) }).length <= 'PDF p.1: '.length + 160)
assert.match(describeSearchFailure({ error: 'no-text-layer' }, 500), /no text layer/)
assert.ok(describeSearchFailure({ error: 'search-failed', detail: 'x'.repeat(500) }, 500).length <= 180,
  'a long Host detail is truncated for the quiet panel')
assert.match(describeSearchFailure({}, 404), /HTTP 404/)

// The composer path is captureInsertion() + insertText(text, span), never setDraft.
{
  const span = { start: 4, end: 4, draftRev: 7 }
  let received
  const actions = {
    captureInsertion: () => span,
    insertText(text, at) {
      received = { text, at }
      return true
    },
    setDraft() {
      throw new Error('the reader must never replace the draft')
    },
  }
  assert.equal(insertComposerText(actions, 'PDF p.132: x'), true)
  assert.equal(received.text, 'PDF p.132: x')
  assert.equal(received.at, span)
}
assert.equal(insertComposerText(undefined, 'x'), false)
assert.equal(insertComposerText({}, 'x'), false)
assert.equal(insertComposerText({
  captureInsertion: () => ({}),
  insertText: () => false,
}, 'x'), false)
assert.equal(insertComposerText({
  captureInsertion: () => ({}),
  insertText: () => { throw new Error('busy') },
}, 'x'), false)

// Binary page selection over cached content offsets, O(log n).
assert.equal(pickPage([], { top: 0, height: 800 }), undefined)
assert.equal(pickPage([{ number: 1, top: 0 }, { number: 2, top: 600 }, { number: 3, top: 1200 }], {
  top: 0,
  height: 800,
}), 1)
assert.equal(pickPage([{ number: 1, top: 0 }, { number: 2, top: 600 }, { number: 3, top: 1200 }], {
  top: 700,
  height: 800,
}), 2)
assert.equal(pickPage([{ number: 1, top: 0 }, { number: 2, top: 600 }, { number: 3, top: 1200 }], {
  top: 5000,
  height: 800,
}), 3)
assert.equal(pickPage([{ number: 1, top: 200 }], { top: 0, height: 800 }), 1, 'above the first page')

// ---------------------------------------------------------------------------
// Debounce / throttle with a deterministic scheduler.
// ---------------------------------------------------------------------------
{
  let now = 0
  let sequence = 0
  const timers = new Map()
  const clock = {
    setTimeout(fn, ms) {
      const id = ++sequence
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    advance(ms) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.fn()
        }
      }
    },
  }
  const hits = []
  const debouncer = createDebouncer(400, clock.setTimeout, clock.clearTimeout)
  debouncer.schedule(() => hits.push('first'))
  clock.advance(100)
  debouncer.schedule(() => hits.push('second'))
  assert.equal(debouncer.pending, true)
  clock.advance(399)
  assert.deepEqual(hits, [], 'the trailing edge has not arrived')
  clock.advance(1)
  assert.deepEqual(hits, ['second'], 'only the last call survives the debounce')
  assert.equal(debouncer.pending, false)
  debouncer.schedule(() => hits.push('cancelled'))
  debouncer.cancel()
  clock.advance(1000)
  assert.deepEqual(hits, ['second'])
}
{
  let frame
  let requested = 0
  const calls = []
  const throttle = createRafThrottle((fn) => {
    requested += 1
    frame = fn
    return 1
  }, () => { frame = undefined })
  throttle.schedule(() => calls.push('a'))
  throttle.schedule(() => calls.push('b'))
  throttle.schedule(() => calls.push('c'))
  assert.equal(requested, 1, 'many scroll events request one frame')
  frame()
  assert.deepEqual(calls, ['c'], 'only the latest read runs')
  throttle.schedule(() => calls.push('d'))
  assert.equal(requested, 2)
  throttle.cancel()
  assert.equal(frame, undefined)
}

// ---------------------------------------------------------------------------
// Saved-view payloads and frame zoom readout.
// ---------------------------------------------------------------------------
assert.equal(clampZoomScale(0.1), 0.25, 'below the fixed range is clamped')
assert.equal(clampZoomScale(9), 4, 'above the fixed range is clamped')
assert.equal(clampZoomScale('1.23456'), 1.235, 'stored scales keep 3 decimals')
assert.equal(clampZoomScale('fit'), undefined)
assert.equal(clampZoomScale(undefined), undefined)
assert.equal(normalizeView({ ok: true, view: null }), undefined)
assert.deepEqual(
  normalizeView({ ok: true, view: { pdfPage: 3, zoomMode: 'fixed', zoomScale: 1.5 } }),
  { pdfPage: 3, zoomMode: 'fixed', zoomScale: 1.5 },
)
assert.deepEqual(
  normalizeView({ ok: true, view: { pdfPage: '3', zoomMode: 'fixed', zoomScale: 1.5 } }),
  undefined,
  'a malformed page is ignored',
)
assert.deepEqual(
  normalizeView({ ok: false, view: { pdfPage: 3 } }),
  undefined,
  'a failed GET is not a view',
)
assert.deepEqual(
  normalizeView({ ok: true, view: { pdfPage: 2, zoomMode: 'bogus', zoomScale: 9 } }),
  { pdfPage: 2, zoomMode: 'fit-width', zoomScale: 4 },
  'unknown modes fall back to fit-width and scales are clamped',
)

// ---------------------------------------------------------------------------
// DOM markers and the inner scrollport (the mechanism dsh-pdf-search proved).
// ---------------------------------------------------------------------------
const probe = document.createElement('span')
header.append(probe)
const pane = resolvePane(probe)
assert.equal(pane, body, 'header contribution resolves its sibling preview body')
assert.equal(resolveScrollport(body), scrollport)
assert.equal(resolveZoomFrame(body, scrollport), zoomFrame, 'the zoom frame is found around the scrollport')
assert.deepEqual(readFrameZoom(zoomFrame), { zoomMode: 'fit-width', zoomScale: 1 })
assert.deepEqual(pageElements(body).map((entry) => entry.number), [1, 2, 3])
probe.remove()

assert.equal(scrollPageIntoView(body, scrollport, 2), true)
assert.ok(scroll.top > 0, 'jumping writes the inner scrollport')
assert.equal(body.scrollTop, 0, 'the preview body itself is never scrolled')
assert.ok(Math.abs(scroll.top - 592) < 1, 'page 2 is placed 8px below the top')
scroll.top = 0

// ---------------------------------------------------------------------------
// Live mount: fetch routes, readout, reporting, jump, search, shortcut.
// ---------------------------------------------------------------------------
const path = `/tmp/dsh-pdf-reader-test-${Date.now()}.pdf`
const requests = []
const posts = []
const viewGets = []
const viewPosts = []
const info = { ok: true, path, pageCount: 3, printedOffset: 1, outline: [] }
const searchHits = [
  { pdf: 2, printed: 1, snippet: '  alpha   beta ' },
  { pdf: 3, printed: 2, snippet: 'gamma delta' },
]
globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  requests.push({ url: target, options })
  if (target.startsWith('/dsh-pdf-reader/info')) {
    return { ok: true, status: 200, json: async () => info }
  }
  if (target.startsWith('/dsh-pdf-reader/search')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, hits: searchHits }) }
  }
  if (target.startsWith('/dsh-pdf-reader/view')) {
    if (String(options.method ?? 'GET').toUpperCase() === 'POST') {
      viewPosts.push(JSON.parse(String(options.body)))
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    viewGets.push(target)
    return { ok: true, status: 200, json: async () => ({ ok: true, view: null }) }
  }
  if (target === '/dsh-pdf-reader/current') {
    posts.push(JSON.parse(String(options.body)))
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not-found' }) }
}

const insertions = []
const inputActions = {
  captureInsertion: () => ({ start: 2, end: 2, draftRev: 11 }),
  insertText(text, span) {
    insertions.push({ text, span })
    return true
  },
  setDraft() {
    throw new Error('the reader must not replace the user draft')
  },
}

const sleep = (ms) => new Promise((resolve) => dom.window.setTimeout(resolve, ms))
const actWait = async (ms = 0) => {
  await React.act(async () => {
    await sleep(ms)
  })
}
const render = async () => {
  await React.act(async () => {
    viewRoot.render(React.createElement(contribution.component, {
      absolutePath: path,
      sessionId: 'session-test',
      inputActions,
    }))
    await sleep(30)
  })
}

const viewRoot = createRoot(header)
await render()
assert.ok(header.querySelector('[data-dsh-pdf-reader="controls"]'), 'the header control mounted')
const pageInput = header.querySelector('[data-dsh-pdf-reader="page"]')
assert.equal(pageInput.value, '1', 'readout starts on physical page 1 (front matter)')
assert.match(header.textContent, /\/ 3/, 'total comes from the Host info route')
assert.ok(requests.some((entry) => entry.url.startsWith('/dsh-pdf-reader/info?path=')))

// ---------------------------------------------------------------------------
// Hover explanations: a localized tooltip on pointer hover and keyboard focus.
// ---------------------------------------------------------------------------
const prevButton = header.querySelector('[data-dsh-pdf-reader="prev"]')
const nextButton = header.querySelector('[data-dsh-pdf-reader="next"]')
const tooltip = () => header.querySelector('[data-dsh-pdf-reader="tip"]')
const hover = async (element, delay = 260) => {
  await React.act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(delay)
  })
}
const leave = async (element) => {
  await React.act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent('mouseout', {
      bubbles: true,
      relatedTarget: document.body,
    }))
    await sleep(20)
  })
}

await hover(prevButton)
assert.ok(tooltip(), 'hovering a control opens its explanation')
assert.equal(tooltip().getAttribute('role'), 'tooltip')
assert.match(tooltip().textContent, /上一页/)
assert.match(tooltip().textContent, /翻到上一页/)

await leave(prevButton)
assert.equal(tooltip(), null, 'leaving the control hides the explanation')

// A quick pass over the toolbar never opens one.
await React.act(async () => {
  nextButton.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
  await sleep(60)
})
assert.equal(tooltip(), null, 'a short hover stays quiet')
await leave(nextButton)

// Keyboard focus opens the same explanation for the page-number control.
await React.act(async () => {
  pageInput.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }))
  await sleep(260)
})
assert.ok(tooltip(), 'focus opens the explanation')
assert.match(tooltip().textContent, /页码/)
assert.match(tooltip().textContent, /印刷页码/)
await React.act(async () => {
  pageInput.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }))
  await sleep(20)
})
assert.equal(tooltip(), null, 'blur hides the explanation')

// The explanation follows the DSH UI language instead of hardcoded English.
localeActive = 'en'
await hover(nextButton)
assert.match(tooltip().textContent, /Next page/)
assert.match(tooltip().textContent, /Go to the next page/)
await leave(nextButton)
localeActive = 'zh'

// Reporting starts after the 400 ms debounce and carries the physical page.
await actWait(450)
assert.equal(posts.length, 1, 'the initial page is reported once')
assert.deepEqual(posts[0], { path, pdfPage: 1, sessionId: 'session-test' })

// Scroll to page 2: printed 1, physical 2. The readout follows, the report debounces.
await React.act(async () => {
  scroll.top = 700
  scrollport.dispatchEvent(new dom.window.Event('scroll'))
  await sleep(40)
})
assert.equal(pageInput.value, '1', 'the readout shows printed page 1 for physical page 2')
await actWait(450)
assert.deepEqual(posts.at(-1), {
  path,
  pdfPage: 2,
  printedPage: 1,
  sessionId: 'session-test',
})

// Toggle AI context off: scrolling must not report, and the in-flight route stops.
const followButton = header.querySelector('[data-dsh-pdf-reader="follow"]')
await React.act(async () => { followButton.click() })
assert.equal(followButton.getAttribute('aria-pressed'), 'false')
const postsWhileOff = posts.length
await React.act(async () => {
  scroll.top = 1300
  scrollport.dispatchEvent(new dom.window.Event('scroll'))
  await sleep(40)
})
assert.equal(pageInput.value, '2', 'physical page 3 is printed page 2')
await actWait(500)
assert.equal(posts.length, postsWhileOff, 'reporting stays off')

// Toggle back on: the current page is reported without waiting for a scroll.
await React.act(async () => { followButton.click() })
assert.equal(followButton.getAttribute('aria-pressed'), 'true')
await actWait(500)
assert.deepEqual(posts.at(-1), {
  path,
  pdfPage: 3,
  printedPage: 2,
  sessionId: 'session-test',
})

// Jump box: plain "1" means printed page 1 -> physical page 2.
await React.act(async () => {
  pageInput.focus()
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  setter.call(pageInput, '1')
  pageInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  pageInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  }))
  await sleep(30)
})
assert.ok(Math.abs(scroll.top - 592) < 1, 'printed 1 jumps to physical page 2')
assert.equal(pageInput.value, '1')

// Prev / next move exactly one physical page and use the inner scrollport.
await React.act(async () => {
  header.querySelector('[data-dsh-pdf-reader="prev"]').click()
  await sleep(30)
})
assert.equal(pageInput.value, '1', 'physical page 1 has no printed label')
await React.act(async () => {
  header.querySelector('[data-dsh-pdf-reader="next"]').click()
  await sleep(30)
})
assert.ok(Math.abs(scroll.top - 592) < 1)
assert.equal(body.scrollTop, 0)

// Search opens, queries after the debounce, lists p.N — snippet, and AI inserts.
await React.act(async () => {
  header.querySelector('[data-dsh-pdf-reader="search"]').click()
  await sleep(10)
})
const panel = header.querySelector('[data-dsh-pdf-reader="panel"]')
assert.ok(panel, 'the search panel opened')
const searchInput = panel.querySelector('input[type="search"]')
await React.act(async () => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  setter.call(searchInput, 'alpha')
  searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await sleep(280)
})
const searchRequest = requests.filter((entry) => entry.url.startsWith('/dsh-pdf-reader/search')).at(-1)
assert.match(searchRequest.url, /ignoreCase=1/)
assert.match(searchRequest.url, /limit=100/)
assert.match(panel.textContent, /p\.1 — alpha beta/)
assert.match(panel.textContent, /→ AI/)

await React.act(async () => {
  panel.querySelectorAll('[data-dsh-pdf-reader="result-ai"]')[0].click()
  await sleep(10)
})
assert.equal(insertions.at(-1).text, 'PDF p.1: alpha beta')

// Clicking a result jumps to its physical page (p.2 in the list).
await React.act(async () => {
  panel.querySelectorAll('[data-dsh-pdf-reader="result"]')[1].click()
  await sleep(30)
})
assert.equal(pageInput.value, '2', 'result for physical page 3 shows printed page 2')
assert.ok(scroll.top > 1000, 'result jumping writes the inner scrollport')

// Close, then prove Ctrl/Cmd+F is not ours and Ctrl/Cmd+Shift+F is.
await React.act(async () => {
  panel.querySelector('[aria-label="Close search"]').click()
  await sleep(10)
})
assert.equal(header.querySelector('[data-dsh-pdf-reader="panel"]'), null)
await React.act(async () => {
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'f',
    metaKey: true,
    bubbles: true,
    cancelable: true,
  }))
})
assert.equal(header.querySelector('[data-dsh-pdf-reader="panel"]'), null, 'plain Cmd+F is never shadowed')
await React.act(async () => {
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'F',
    metaKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  }))
  await sleep(10)
})
assert.ok(header.querySelector('[data-dsh-pdf-reader="panel"]'), 'Cmd+Shift+F opens search')
await React.act(async () => {
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  }))
})

// The first mount had no saved row, yet still fetches once and records a view.
const firstViewGets = viewGets.filter(
  (url) => url.startsWith(`/dsh-pdf-reader/view?path=${encodeURIComponent(path)}`),
)
assert.equal(firstViewGets.length, 1, 'one saved-view GET per PDF mount')
assert.ok(viewPosts.length >= 1, 'the view is saved even when the Host has no row yet')
assert.ok(viewPosts.every((entry) => entry.path === path))
assert.ok(viewPosts.every((entry) => Number.isInteger(entry.pdfPage) && entry.pdfPage >= 1 && entry.pdfPage <= 3))
assert.ok(viewPosts.every((entry) => entry.zoomMode === 'fit-width' || entry.zoomMode === 'fixed'))
assert.ok(viewPosts.every((entry) => entry.zoomScale >= 0.25 && entry.zoomScale <= 4))

// ---------------------------------------------------------------------------
// Two previews: the shortcut belongs to the preview the pointer last claimed.
// ---------------------------------------------------------------------------
const secondPreview = document.createElement('div')
secondPreview.innerHTML = `
  <div id="header-two"></div>
  <div data-textpreview-body>
    <div data-document-zoom-scrollport>
      <section data-pdf-preview>
        <div data-pdf-page="1"></div>
      </section>
    </div>
  </div>`
document.body.append(secondPreview)
const secondHeader = secondPreview.querySelector('#header-two')
const secondRoot = createRoot(secondHeader)
const secondPath = `/tmp/dsh-pdf-reader-test-two-${Date.now()}.pdf`
await React.act(async () => {
  secondRoot.render(React.createElement(contribution.component, {
    absolutePath: secondPath,
    sessionId: 'session-test',
    inputActions,
  }))
  await sleep(30)
})
assert.ok(secondHeader.querySelector('[data-dsh-pdf-reader="controls"]'), 'second preview mounted')

// Close the first panel before the election.
const firstPanel = header.querySelector('[data-dsh-pdf-reader="panel"]')
if (firstPanel !== null) {
  await React.act(async () => { firstPanel.querySelector('[aria-label="Close search"]').click() })
}

// Claim the second preview by pointing at it, then press the chord.
await React.act(async () => {
  secondHeader.querySelector('[data-dsh-pdf-reader="controls"]').dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }))
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'f',
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  }))
  await sleep(10)
})
assert.ok(secondHeader.querySelector('[data-dsh-pdf-reader="panel"]'), 'the claimed preview opens')
assert.equal(header.querySelector('[data-dsh-pdf-reader="panel"]'), null, 'the other preview stays closed')

// Claim the first preview again; the chord now targets it.
await React.act(async () => {
  header.querySelector('[data-dsh-pdf-reader="controls"]').dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }))
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'f',
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  }))
  await sleep(10)
})
assert.ok(header.querySelector('[data-dsh-pdf-reader="panel"]'), 'the newly claimed preview opens')

// ---------------------------------------------------------------------------
// Cleanup: unmount removes the controls, listeners, and panel.
// ---------------------------------------------------------------------------
await React.act(async () => { secondRoot.unmount() })
await React.act(async () => { viewRoot.unmount() })
assert.equal(header.querySelector('[data-dsh-pdf-reader="controls"]'), null)
assert.equal(secondHeader.querySelector('[data-dsh-pdf-reader="controls"]'), null)
await React.act(async () => {
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'f',
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  }))
})
assert.equal(document.querySelector('[data-dsh-pdf-reader="panel"]'), null, 'no listener survives unmount')
secondPreview.remove()

// ---------------------------------------------------------------------------
// Missing Host routes are quiet: the preview still mounts and the total falls
// back to the page placeholders, while search/report show an error (not throw).
// ---------------------------------------------------------------------------
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })
scroll.top = 0
const failingPath = `/tmp/dsh-pdf-reader-missing-host-${Date.now()}.pdf`
const failingRoot = createRoot(header)
await React.act(async () => {
  failingRoot.render(React.createElement(contribution.component, {
    absolutePath: failingPath,
    sessionId: 'session-test',
    inputActions,
  }))
  await sleep(40)
})
assert.ok(header.querySelector('[data-dsh-pdf-reader="controls"]'), 'the preview still composes')
assert.equal(header.querySelector('[data-dsh-pdf-reader="page"]').value, '1')
assert.match(header.textContent, /\/ 3/, 'the DOM page placeholders supply the fallback total')
await React.act(async () => {
  header.querySelector('[data-dsh-pdf-reader="search"]').click()
  await sleep(10)
})
const failingSearch = header.querySelector('[data-dsh-pdf-reader="panel"] input[type="search"]')
await React.act(async () => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  setter.call(failingSearch, 'anything')
  failingSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await sleep(280)
})
assert.match(header.querySelector('[data-dsh-pdf-reader="panel"]').textContent, /Search unavailable/)
await actWait(450)
const failingFollow = header.querySelector('[data-dsh-pdf-reader="follow"]')
await React.act(async () => {
  failingFollow.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true }))
  await sleep(260)
})
assert.match(tooltip().textContent, /Host 路由不可用/, 'the explanation reports the failed route')
await React.act(async () => {
  failingFollow.dispatchEvent(new dom.window.MouseEvent('mouseout', {
    bubbles: true,
    relatedTarget: document.body,
  }))
  await sleep(20)
})
await React.act(async () => { failingRoot.unmount() })
assert.equal(header.querySelector('[data-dsh-pdf-reader="controls"]'), null)

// Non-PDF previews are untouched: no controls, no host calls, no shortcut.
let nonPdfFetches = 0
globalThis.fetch = async () => {
  nonPdfFetches += 1
  return { ok: false, status: 404, json: async () => ({}) }
}
const nonPdfRoot = createRoot(header)
await React.act(async () => {
  nonPdfRoot.render(React.createElement(contribution.component, {
    absolutePath: '/tmp/notes.md',
    sessionId: 'session-test',
    inputActions,
  }))
  await sleep(30)
})
assert.equal(header.querySelector('[data-dsh-pdf-reader="controls"]'), null)
assert.equal(nonPdfFetches, 0, 'non-PDF files issue no host requests, including GET /view')
await React.act(async () => {
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'f',
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  }))
})
assert.equal(document.querySelector('[data-dsh-pdf-reader="panel"]'), null)
await React.act(async () => { nonPdfRoot.unmount() })

// In-flight info/search requests are aborted on unmount, not left to settle.
const pendingSignals = []
globalThis.fetch = (url, options = {}) => {
  pendingSignals.push({ url: String(url), signal: options.signal })
  return new Promise(() => {})
}
scroll.top = 0
const abortRoot = createRoot(header)
await React.act(async () => {
  abortRoot.render(React.createElement(contribution.component, {
    absolutePath: `/tmp/dsh-pdf-reader-abort-${Date.now()}.pdf`,
    sessionId: 'session-test',
    inputActions,
  }))
  await sleep(30)
})
await React.act(async () => {
  header.querySelector('[data-dsh-pdf-reader="search"]').click()
  await sleep(10)
})
await React.act(async () => {
  const abortSearch = header.querySelector('[data-dsh-pdf-reader="panel"] input[type="search"]')
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  setter.call(abortSearch, 'pending')
  abortSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  await sleep(260)
})
assert.ok(pendingSignals.length >= 2, 'info and search requests were issued')
await React.act(async () => { abortRoot.unmount() })
assert.ok(pendingSignals.every((entry) => entry.signal?.aborted === true), 'unmount aborts every in-flight fetch')

// ---------------------------------------------------------------------------
// Per-book view memory: restore page 3 at a fixed 1.5x from the Host, hold the
// save gate until the restore lands, then persist page/zoom changes.
// ---------------------------------------------------------------------------
const restorePath = `/tmp/dsh-pdf-reader-restore-${Date.now()}.pdf`
const restoreGets = []
const restorePosts = []
const restoreCurrent = []
const restoreWheels = []
let releaseView
const heldView = new Promise((resolve) => { releaseView = resolve })
const savedView = {
  path: restorePath,
  pdfPage: 3,
  zoomMode: 'fixed',
  zoomScale: 1.5,
  updatedAt: '2026-10-20T00:00:00.000Z',
}
globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  if (target.startsWith('/dsh-pdf-reader/view')) {
    if (String(options.method ?? 'GET').toUpperCase() === 'POST') {
      restorePosts.push(JSON.parse(String(options.body)))
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    restoreGets.push(target)
    const body = await heldView
    return { ok: true, status: 200, json: async () => body }
  }
  if (target.startsWith('/dsh-pdf-reader/info')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, pageCount: 3, outline: [] }) }
  }
  if (target === '/dsh-pdf-reader/current') {
    restoreCurrent.push(JSON.parse(String(options.body)))
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  return { ok: false, status: 404, json: async () => ({ ok: false }) }
}

/**
 * The real preview applies a Ctrl+wheel gesture to the frame. Mirroring that
 * here makes the restore loop converge exactly like it does in the browser.
 */
const applyZoomWheel = (event) => {
  restoreWheels.push({
    ctrlKey: event.ctrlKey,
    deltaY: event.deltaY,
    deltaMode: event.deltaMode,
  })
  const current = Number.parseFloat(zoomFrame.style.getPropertyValue('--document-zoom')) || 1
  const next = Math.min(4, Math.max(0.25, current * Math.exp(-event.deltaY * 0.01)))
  zoomFrame.style.setProperty('--document-zoom', String(next))
  zoomFrame.setAttribute('data-document-zoom-mode', 'fixed')
}
scrollport.addEventListener('wheel', applyZoomWheel)

zoomFrame.setAttribute('data-document-zoom-mode', 'fit-width')
zoomFrame.style.setProperty('--document-zoom', '1')
scroll.top = 0
const restoreRoot = createRoot(header)
await React.act(async () => {
  restoreRoot.render(React.createElement(contribution.component, {
    absolutePath: restorePath,
    sessionId: 'session-test',
    inputActions,
  }))
  await sleep(30)
})
assert.equal(restoreGets.length, 1, 'one saved-view GET per PDF mount')
assert.equal(
  restoreGets[0],
  `/dsh-pdf-reader/view?path=${encodeURIComponent(restorePath)}`,
  'the GET carries the encoded absolute path',
)
assert.equal(header.querySelector('[data-dsh-pdf-reader="page"]').value, '1')

// While the GET is held, page sampling/reporting runs, but nothing may be saved.
await actWait(700)
assert.ok(restoreCurrent.length >= 1, 'the page report path ran while the view GET was pending')
assert.equal(restorePosts.length, 0, 'no /view POST before the saved view resolves')
assert.equal(scroll.top, 0, 'the saved page is not restored before the view resolves')

await React.act(async () => {
  releaseView({ ok: true, view: savedView })
  await sleep(30)
})
assert.ok(restoreWheels.length >= 1, 'the plugin dispatched a synthetic zoom gesture')
assert.equal(restoreWheels[0].ctrlKey, true, 'the wheel gesture looks like a Ctrl+wheel pinch')
assert.ok(Number.isFinite(restoreWheels[0].deltaY))
assert.ok(restoreWheels[0].deltaY < 0, 'the saved 1.5x needs zooming in')
assert.equal(restoreWheels[0].deltaMode, 0)
assert.equal(restorePosts.length, 0, 'no save while the restore is still placing the page')

await actWait(1000)
const restoredScaled = Math.round(
  Number.parseFloat(zoomFrame.style.getPropertyValue('--document-zoom')) * 1000,
) / 1000
assert.ok(Math.abs(scroll.top - 1192) < 1, 'the scrollport ends on saved page 3')
assert.equal(header.querySelector('[data-dsh-pdf-reader="page"]').value, '3', 'the readout follows the restore')
assert.ok(restorePosts.length >= 1, 'the restored view is saved after the gate opens')
const restoredPost = restorePosts.at(-1)
assert.deepEqual(
  Object.keys(restoredPost).sort(),
  ['path', 'pdfPage', 'zoomMode', 'zoomScale'],
  'only the four client fields are sent',
)
assert.equal(restoredPost.path, restorePath)
assert.equal(restoredPost.pdfPage, 3)
assert.equal(restoredPost.zoomMode, 'fixed')
assert.equal(restoredPost.zoomScale, restoredScaled, 'zoomScale is read from the frame')
assert.ok(Math.abs(restoredPost.zoomScale - 1.5) <= 1.5 * 0.02, 'the restored scale is within 2%')
assert.ok(restorePosts.every((entry) => entry.pdfPage === 3), 'no restore-time page 1 overwrote the saved page')

// A frame attribute change (zoom commit) schedules another debounced save.
const postsBeforeZoom = restorePosts.length
await React.act(async () => {
  zoomFrame.setAttribute('data-document-zoom-mode', 'fixed')
  zoomFrame.style.setProperty('--document-zoom', '1.75')
  await sleep(30)
})
await actWait(700)
assert.ok(restorePosts.length > postsBeforeZoom, 'a frame zoom change triggers a later /view POST')
assert.equal(restorePosts.at(-1).pdfPage, 3)
assert.equal(restorePosts.at(-1).zoomMode, 'fixed')
assert.ok(Math.abs(restorePosts.at(-1).zoomScale - 1.75) < 0.002)

// The sampled page piggybacks on the same debounced save.
await React.act(async () => {
  scroll.top = 700
  scrollport.dispatchEvent(new dom.window.Event('scroll'))
  await sleep(40)
})
await actWait(700)
assert.equal(restorePosts.at(-1).pdfPage, 2, 'a page change is saved after the same debounce')
assert.equal(restorePosts.at(-1).zoomMode, 'fixed')
assert.equal(restorePosts.at(-1).zoomScale, 1.75)

await React.act(async () => { restoreRoot.unmount() })
assert.equal(header.querySelector('[data-dsh-pdf-reader="controls"]'), null)
scrollport.removeEventListener('wheel', applyZoomWheel)

// ---------------------------------------------------------------------------
// A saved fit-width view restores only the page: the default mode is left alone.
// ---------------------------------------------------------------------------
const fitPath = `/tmp/dsh-pdf-reader-fit-${Date.now()}.pdf`
const fitPosts = []
const fitCurrent = []
let fitWheels = 0
const countFitWheel = () => { fitWheels += 1 }
globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  if (target.startsWith('/dsh-pdf-reader/view')) {
    if (String(options.method ?? 'GET').toUpperCase() === 'POST') {
      fitPosts.push(JSON.parse(String(options.body)))
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        view: { path: fitPath, pdfPage: 2, zoomMode: 'fit-width', zoomScale: 1.5 },
      }),
    }
  }
  if (target.startsWith('/dsh-pdf-reader/info')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, pageCount: 3, outline: [] }) }
  }
  if (target === '/dsh-pdf-reader/current') {
    fitCurrent.push(JSON.parse(String(options.body)))
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  return { ok: false, status: 404, json: async () => ({ ok: false }) }
}
scrollport.addEventListener('wheel', countFitWheel)
zoomFrame.setAttribute('data-document-zoom-mode', 'fit-width')
zoomFrame.style.setProperty('--document-zoom', '1.13')
scroll.top = 0
const fitRoot = createRoot(header)
await React.act(async () => {
  fitRoot.render(React.createElement(contribution.component, {
    absolutePath: fitPath,
    sessionId: 'session-test',
    inputActions,
  }))
  await sleep(30)
})
await actWait(900)
assert.equal(fitWheels, 0, 'a fit-width view never forces a fixed scale')
assert.ok(Math.abs(scroll.top - 592) < 1, 'the saved page is restored in fit-width mode')
assert.equal(header.querySelector('[data-dsh-pdf-reader="page"]').value, '2')
assert.equal(zoomFrame.getAttribute('data-document-zoom-mode'), 'fit-width')
assert.ok(fitPosts.length >= 1)
assert.equal(fitPosts.at(-1).pdfPage, 2)
assert.equal(fitPosts.at(-1).zoomMode, 'fit-width')
assert.ok(
  Math.abs(fitPosts.at(-1).zoomScale - 1.13) < 0.002,
  'the resolved fit-width scale is stored informationally',
)
assert.ok(fitPosts.every((entry) => entry.pdfPage === 2), 'the restore-time page 1 was never saved')
await React.act(async () => { fitRoot.unmount() })
scrollport.removeEventListener('wheel', countFitWheel)

console.log('dsh-pdf-reader: client bundle OK — slot registration, numbering, '
  + 'composer insertion, debounce/throttle, live scroll/jump/search/report/cleanup, '
  + 'missing-route/non-PDF tolerance, abort-on-unmount, saved-page/zoom restore, '
  + 'gated page/zoom persistence')
