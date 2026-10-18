/**
 * Headless checks for dsh-pdf-reader's browser bundle.
 *
 * Run: node dsh-pdf-reader/test/plugin.test.mjs
 *
 * These tests evaluate the real `lib/client.js` through a fake
 * `window.__ModuleLoader__`, exercise the pure page-selection helpers, and
 * server-render the header component. They do not pretend to mount the plugin
 * in the live GUI; that needs a profile install.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { JSDOM } from '../../dsh-pdf-search/node_modules/jsdom/lib/api.js'

const requireFromSibling = createRequire(new URL('../../dsh-pdf-search/package.json', import.meta.url))
const React = requireFromSibling('react')
const ReactDOMServer = requireFromSibling('react-dom/server')

const dom = new JSDOM(`<!doctype html><html><body>
  <div id="wrap">
    <div id="header"><span id="host"></span></div>
    <div data-textpreview-body>
      <div data-document-zoom-scrollport>
        <div data-pdf-page="1" style="height:600px"></div>
        <div data-pdf-page="2" style="height:600px"></div>
        <div data-pdf-page="3" style="height:600px"></div>
      </div>
    </div>
  </div>
</body></html>`, { url: 'http://127.0.0.1/' })

globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.MutationObserver = dom.window.MutationObserver
globalThis.HTMLElement = dom.window.HTMLElement

let registered
dom.window.__ModuleLoader__ = {
  load({ id, factory }) {
    assert.equal(id, 'dsh-pdf-reader')
    const module = factory(specifier => {
      assert.equal(specifier, 'react')
      return React
    })
    registered = module
  },
}

await import('../lib/client.js')
assert.ok(registered, 'bundle registered itself with the module loader')
assert.deepEqual(registered.inject, ['slots'])

let contribution
const ctx = {
  effect(run) { return run() },
  slots: {
    inject(name, run) {
      assert.equal(name, 'sidebar.right.tab.document.actions')
      return run()
    },
    register(options, component) {
      contribution = { options, component }
      return () => {}
    },
  },
}
registered.apply(ctx)
assert.equal(contribution.options.name, 'sidebar.right.tab.document.actions')
assert.equal(contribution.options.id, 'pdf-page-tools')
assert.equal(contribution.options.order, -6)
assert.equal(typeof contribution.component, 'function')

const { pickPage, formatReference, appendToComposer, resolvePane, resolveScrollport, pageElements } = registered.__test

// Pure page selection: the page containing the anchor (top + 30% of viewport).
assert.equal(pickPage([
  { number: 1, top: -500 },
  { number: 2, top: 100 },
  { number: 3, top: 700 },
], { top: 0, height: 800 }), 2)
assert.equal(pickPage([
  { number: 1, top: 0 },
  { number: 2, top: 600 },
], { top: 0, height: 800 }), 1)
assert.equal(pickPage([], { top: 0, height: 800 }), undefined)

// Reference text names the physical PDF page explicitly.
assert.equal(formatReference('/tmp/book.pdf', 292), 'PDF: /tmp/book.pdf — read page 292')

// The share path appends to the real composer draft via the conversation
// service, preserving unsent text (the same shape dsh-better-sidebar uses).
const drafts = []
const fakeClientCtx = {
  sessions: { scope(id) { return { id } } },
  get(name) {
    if (name !== 'conversation') return undefined
    return {
      input: {
        for() {
          return {
            state: { getSnapshot() { return { draft: 'explain this' } } },
            setDraft(next) { drafts.push(next) },
          }
        },
      },
    }
  },
}
assert.equal(appendToComposer(fakeClientCtx, 'session-1', formatReference('/tmp/book.pdf', 7)), true)
assert.equal(drafts[0], 'explain this\n\nPDF: /tmp/book.pdf — read page 7')
assert.equal(appendToComposer(undefined, 'session-1', 'x'), false)

// Real DOM: the header contribution resolves its sibling preview body.
const host = document.getElementById('host')
const pane = resolvePane(host)
assert.ok(pane?.hasAttribute('data-textpreview-body'), 'pane resolved from the header')
assert.equal(resolveScrollport(pane)?.hasAttribute('data-document-zoom-scrollport'), true)
assert.deepEqual(pageElements(pane).map(p => p.number), [1, 2, 3])

// The component renders without a live composer and offers both controls.
const markup = ReactDOMServer.renderToStaticMarkup(
  React.createElement(contribution.component, { absolutePath: '/tmp/book.pdf' }),
)
assert.match(markup, /type="number"/)
assert.match(markup, /aria-label="PDF page"/)
assert.match(markup, /aria-label="Share this PDF page with the chat"/)

// With the session standard kit present, the composer path is chosen and the
// hook is actually read (server rendering calls it once).
let draftRead = false
const withInputMarkup = ReactDOMServer.renderToStaticMarkup(
  React.createElement(contribution.component, {
    absolutePath: '/tmp/book.pdf',
    useInput(selector) { draftRead = true; assert.equal(typeof selector, 'function'); return '' },
    inputActions: { setDraft() {} },
  }),
)
assert.equal(draftRead, true)
assert.match(withInputMarkup, /type="number"/)

console.log('ok: bundle loads, slot registration, page math, pane resolution, component render, composer hook')
