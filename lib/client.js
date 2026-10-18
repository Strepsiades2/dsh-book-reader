/**
 * dsh-pdf-reader — browser half.
 *
 * Decorates DSH's official PDF preview; it never replaces the renderer:
 *   - current-page readout, prev/next page, and a page-jump box;
 *   - a search panel (Cmd/Ctrl+Shift+F) backed by the Host text route;
 *   - "→ AI" and "share this page" insertions into the chat composer;
 *   - debounced current-page reporting for AI context, with an on/off toggle.
 *
 * The contribution mounts into the preview's own header slot
 * `sidebar.right.tab.document.actions`, which the preview declares as a
 * Session-scoped list and passes `{ absolutePath }` to. Session-scoped slots
 * also receive the standard `sessionId` and `inputActions` props; insertion
 * uses `captureInsertion()` + `insertText(text, span)`, so the user's draft is
 * preserved and the edit is undoable. It never calls `setDraft`.
 *
 * The bundle is the module-loader factory shape used by the profile:
 * `window.__ModuleLoader__.load({ id, factory })`, React is the only external.
 */
window.__ModuleLoader__.load({
  id: 'dsh-pdf-reader',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { useEffect, useRef, useState } = React
    const h = React.createElement

    /** Host routes implemented by the Host half. */
    const INFO_ROUTE = '/dsh-pdf-reader/info'
    const SEARCH_ROUTE = '/dsh-pdf-reader/search'
    const CURRENT_ROUTE = '/dsh-pdf-reader/current'

    /** DOM markers owned by the official preview (same ones dsh-pdf-search uses). */
    const PANE_ATTR = 'data-textpreview-body'
    const SCROLL_ATTR = 'data-document-zoom-scrollport'
    const PAGE_ATTR = 'data-pdf-page'
    const PDF_SECTION_ATTR = 'data-pdf-preview'

    /** Timing. Reporting is the only debounced write; scrolling uses one rAF. */
    const REPORT_DELAY_MS = 400
    const SEARCH_DELAY_MS = 220
    const INFO_TIMEOUT_MS = 30_000
    const SEARCH_TIMEOUT_MS = 60_000
    const REPORT_TIMEOUT_MS = 6_000
    const FLASH_MS = 1_600
    const SEARCH_LIMIT = 100
    const INFO_CACHE_LIMIT = 16

    /** Non-PDF files are left entirely alone (Office previews have .docx paths). */
    function isPdfPath(value) {
      return typeof value === 'string' && /\.pdf$/iu.test(value)
    }

    /** @returns whether value is a positive integer. */
    function positiveInteger(value) {
      return typeof value === 'number' && Number.isInteger(value) && value > 0
    }

    /**
     * Printed page for a physical PDF page.
     *
     * The Host contract defines `printedOffset` so that
     * `physical = printed + printedOffset` (LADR: printed 132 -> PDF 152), which
     * is the same convention `pdfkit info` prints. Front matter has no numeric
     * printed label; page numbers at or below the offset yield `undefined`.
     * @param pdfPage - 1-based physical page.
     * @param printedOffset - Host-reported offset.
     * @returns the 1-based printed page, or `undefined` when not derivable.
     */
    function printedPageOf(pdfPage, printedOffset) {
      if (!positiveInteger(pdfPage)) return undefined
      if (typeof printedOffset !== 'number' || !Number.isInteger(printedOffset)) return undefined
      const printed = pdfPage - printedOffset
      return printed >= 1 ? printed : undefined
    }

    /** @returns the number to show in the readout: printed when known, else physical. */
    function displayPage(pdfPage, printedOffset) {
      const printed = printedPageOf(pdfPage, printedOffset)
      return printed === undefined ? pdfPage : printed
    }

    /**
     * Parse the page-jump box.
     *
     * Accepted forms:
     *   - `132`  — a printed page when an offset is known, otherwise physical;
     *   - `p152`, `pdf 152`, `#152` — always a physical PDF page;
     *   - surrounding whitespace and a dot after the prefix (`p.152`).
     * Values outside `1..pageCount` are rejected rather than clamped, so a
     * mistyped printed page cannot silently land on the last page.
     * @param raw - input value.
     * @param options - `{ printedOffset, pageCount }`.
     * @returns a 1-based physical PDF page, or `undefined`.
     */
    function parsePageInput(raw, options) {
      const text = String(raw ?? '').trim()
      if (text === '') return undefined
      const match = /^(?:(p|pdf|#)\.?\s*)?(\d+)$/iu.exec(text)
      if (match === null) return undefined
      const explicitPhysical = match[1] !== undefined
      const value = Number(match[2])
      if (!Number.isSafeInteger(value) || value < 1) return undefined
      const printedOffset = options?.printedOffset
      const knownOffset = typeof printedOffset === 'number' && Number.isInteger(printedOffset)
      const page = explicitPhysical || !knownOffset ? value : value + printedOffset
      if (!Number.isSafeInteger(page) || page < 1) return undefined
      const pageCount = options?.pageCount
      if (positiveInteger(pageCount) && page > pageCount) return undefined
      return page
    }

    /** Collapse whitespace and bound a Host snippet for the composer. */
    function normalizeSnippet(value, limit = 160) {
      const source = typeof value === 'string' ? value : ''
      const clean = source.replace(/\s+/gu, ' ').trim()
      const max = positiveInteger(limit) ? limit : 160
      if (clean.length <= max) return clean
      return `${clean.slice(0, max - 1).trimEnd()}…`
    }

    /** @returns the `p.N` label for one search hit. */
    function searchResultPage(hit) {
      if (positiveInteger(hit?.printed)) return hit.printed
      if (positiveInteger(hit?.pdf)) return hit.pdf
      return undefined
    }

    /** @returns the short list label `p.132`, or `p.?` for a malformed hit. */
    function searchResultLabel(hit) {
      const page = searchResultPage(hit)
      return page === undefined ? 'p.?' : `p.${page}`
    }

    /** @returns `[PDF p.132]` for the share button. */
    function buildShareReference(pdfPage, printedOffset) {
      return `[PDF p.${displayPage(pdfPage, printedOffset)}]`
    }

    /** @returns `PDF p.132: <snippet>` (or `[PDF p.132]` when there is no snippet). */
    function buildSearchReference(hit) {
      const page = searchResultPage(hit)
      const label = page === undefined ? '?' : String(page)
      const snippet = normalizeSnippet(hit?.snippet)
      return snippet === '' ? `[PDF p.${label}]` : `PDF p.${label}: ${snippet}`
    }

    /**
     * Insert into the composer through the Session standard props.
     *
     * `captureInsertion()` snapshots the selection and draft revision;
     * `insertText()` applies one undoable plain-text edit only while that
     * revision is current. Rejected insertions are reported as `false` so the
     * caller can copy the reference instead; the draft is never replaced.
     * @param inputActions - standard slot prop.
     * @param text - plain text to insert.
     * @returns whether the edit applied.
     */
    function insertComposerText(inputActions, text) {
      if (inputActions === null || typeof inputActions !== 'object') return false
      if (typeof inputActions.captureInsertion !== 'function') return false
      if (typeof inputActions.insertText !== 'function') return false
      try {
        const span = inputActions.captureInsertion()
        if (span === null || typeof span !== 'object') return false
        return inputActions.insertText(String(text), span) === true
      } catch (_error) {
        return false
      }
    }

    /**
     * Pick the page occupying the reading anchor near the top of the viewport.
     *
     * Pages are sorted by `top` (content coordinates when fed cached geometry,
     * viewport coordinates for the pure tests). Binary search keeps a 410-page
     * document at O(log n) per scroll; no DOM work happens here.
     * @param pages - `[{ number, top }]`.
     * @param viewport - `{ top, height }`.
     * @returns the page number, or `undefined` for an empty sequence.
     */
    function pickPage(pages, viewport) {
      if (!Array.isArray(pages) || pages.length === 0) return undefined
      const top = Number.isFinite(viewport?.top) ? viewport.top : 0
      const height = Number.isFinite(viewport?.height) ? Math.max(0, viewport.height) : 0
      const anchor = top + Math.min(180, Math.max(40, height * 0.3))
      let low = 0
      let high = pages.length - 1
      let found = 0
      while (low <= high) {
        const mid = (low + high) >> 1
        const pageTop = pages[mid]?.top
        if (typeof pageTop === 'number' && Number.isFinite(pageTop) && pageTop <= anchor) {
          found = mid
          low = mid + 1
        } else {
          high = mid - 1
        }
      }
      return pages[found]?.number
    }

    /** @returns whether value is an Element in the current document. */
    function isElement(value) {
      return typeof HTMLElement === 'function' && value instanceof HTMLElement
    }

    /**
     * Every PDF page placeholder currently in the pane, in page order.
     *
     * The official PDF body renders one `[data-pdf-page]` wrapper per page up
     * front; unrendered pages are 3:4 placeholders, so this is stable before
     * lazy rendering completes.
     * @param pane - preview body.
     * @returns `[{ number, element }]` sorted by page number.
     */
    function pageElements(pane) {
      if (pane === null || pane === undefined || typeof pane.querySelectorAll !== 'function') return []
      const out = []
      for (const element of pane.querySelectorAll(`[${PAGE_ATTR}]`)) {
        if (!isElement(element)) continue
        const number = Number(element.getAttribute(PAGE_ATTR))
        if (positiveInteger(number)) out.push({ number, element })
      }
      out.sort((left, right) => left.number - right.number)
      return out
    }

    /**
     * Find the preview body that owns one header contribution.
     *
     * The contribution renders in the header; the body is a sibling inside the
     * preview wrapper. Walk a few ancestors looking for the body marker
     * (mirrors dsh-pdf-search/src/client/action.ts:162-170).
     * @param node - the contribution's own element.
     * @returns the preview body, or `undefined` while the preview is not composed.
     */
    function resolvePane(node) {
      let parent = node?.parentElement ?? null
      for (let depth = 0; parent !== null && depth < 4; depth += 1, parent = parent.parentElement) {
        if (typeof parent.hasAttribute === 'function' && parent.hasAttribute(PANE_ATTR)) return parent
        if (typeof parent.querySelector === 'function') {
          const body = parent.querySelector(`[${PANE_ATTR}]`)
          if (isElement(body)) return body
        }
      }
      return undefined
    }

    /**
     * Find the element that actually scrolls the preview.
     *
     * The preview body is not the scrollport: the PDF renderer owns an inner
     * one marked `data-document-zoom-scrollport`. The overflow walk-up is only
     * a fallback for a future renderer (mirrors
     * dsh-pdf-search/src/client/action.ts:172-192).
     * @param pane - preview body.
     * @returns the scrolling element, or `undefined` when nothing scrolls yet.
     */
    function resolveScrollport(pane) {
      if (pane === null || pane === undefined || typeof pane.querySelector !== 'function') return undefined
      const marked = pane.querySelector(`[${SCROLL_ATTR}]`)
      if (isElement(marked)) return marked
      for (let node = pane; node !== null; node = node.parentElement) {
        if (typeof node.ownerDocument?.defaultView?.getComputedStyle !== 'function') continue
        const style = node.ownerDocument.defaultView.getComputedStyle(node)
        if (!/(auto|scroll|overlay)/u.test(style.overflowY)) continue
        if (node.scrollHeight > node.clientHeight + 1) return node
      }
      return undefined
    }

    /**
     * Scroll one page near the top of the preview.
     *
     * This is the mechanism dsh-pdf-search proved: write the inner scrollport,
     * never the preview body. Bringing the page into the viewport is also what
     * makes the renderer's IntersectionObserver draw a lazily rendered page.
     * @param pane - preview body.
     * @param scrollport - inner scrolling element.
     * @param page - 1-based physical page.
     * @returns whether a target was found and a scroll was attempted.
     */
    function scrollPageIntoView(pane, scrollport, page) {
      if (!positiveInteger(page) || pane === null || pane === undefined || typeof pane.querySelector !== 'function') {
        return false
      }
      const target = pane.querySelector(`[${PAGE_ATTR}="${page}"]`)
      if (target === null || target === undefined) return false
      if (scrollport !== null && scrollport !== undefined
        && typeof scrollport.scrollTop === 'number'
        && typeof scrollport.getBoundingClientRect === 'function'
        && typeof target.getBoundingClientRect === 'function') {
        const targetRect = target.getBoundingClientRect()
        const portRect = scrollport.getBoundingClientRect()
        scrollport.scrollTop += targetRect.top - portRect.top - 8
        return true
      }
      if (typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'start' })
        return true
      }
      return false
    }

    /**
     * A cancellable trailing-edge debouncer.
     * @param delay - milliseconds.
     * @param setTimer - scheduler (injectable for tests).
     * @param clearTimer - canceller (injectable for tests).
     */
    function createDebouncer(delay, setTimer, clearTimer) {
      const schedule = typeof setTimer === 'function' ? setTimer : (fn, ms) => globalThis.setTimeout(fn, ms)
      const cancel = typeof clearTimer === 'function' ? clearTimer : (id) => globalThis.clearTimeout(id)
      const wait = Number.isFinite(delay) ? Math.max(0, delay) : 0
      let timer
      return {
        schedule(run) {
          if (typeof run !== 'function') return
          if (timer !== undefined) cancel(timer)
          timer = schedule(() => {
            timer = undefined
            run()
          }, wait)
        },
        cancel() {
          if (timer === undefined) return
          cancel(timer)
          timer = undefined
        },
        get pending() {
          return timer !== undefined
        },
      }
    }

    /**
     * A one-frame leading/trailing throttle: many scroll events, one read.
     * @param requestFrame - scheduler (injectable for tests).
     * @param cancelFrame - canceller (injectable for tests).
     */
    function createRafThrottle(requestFrame, cancelFrame) {
      const request = typeof requestFrame === 'function'
        ? requestFrame
        : (fn) => globalThis.requestAnimationFrame(fn)
      const cancel = typeof cancelFrame === 'function'
        ? cancelFrame
        : (id) => globalThis.cancelAnimationFrame(id)
      let handle
      let pending
      return {
        schedule(run) {
          if (typeof run !== 'function') return
          pending = run
          if (handle !== undefined) return
          handle = request(() => {
            handle = undefined
            const next = pending
            pending = undefined
            if (next !== undefined) next()
          })
        },
        cancel() {
          if (handle !== undefined) {
            cancel(handle)
            handle = undefined
          }
          pending = undefined
        },
        get pending() {
          return pending !== undefined
        },
      }
    }

    /** @returns whether an error is the expected AbortController rejection. */
    function isAbortError(error) {
      return error !== null && typeof error === 'object' && error.name === 'AbortError'
    }

    /** Read a JSON response without letting a non-JSON body crash the preview. */
    async function fetchJson(url, options) {
      const response = await fetch(url, options)
      let body = null
      try {
        body = await response.json()
      } catch (_error) {
        body = null
      }
      return { status: response.status, ok: response.ok, body }
    }

    /** Normalize the Host `/info` payload. */
    function normalizeInfo(body) {
      if (body === null || typeof body !== 'object' || body.ok !== true) return undefined
      return {
        pageCount: positiveInteger(body.pageCount) ? body.pageCount : undefined,
        printedOffset: typeof body.printedOffset === 'number' && Number.isInteger(body.printedOffset)
          ? body.printedOffset
          : undefined,
        outline: Array.isArray(body.outline) ? body.outline : [],
      }
    }

    /** Validate one search hit from the Host. */
    function normalizeHit(value) {
      if (value === null || typeof value !== 'object') return undefined
      if (!positiveInteger(value.pdf)) return undefined
      return {
        pdf: value.pdf,
        printed: positiveInteger(value.printed) ? value.printed : undefined,
        snippet: typeof value.snippet === 'string' ? value.snippet : '',
      }
    }

    /** Turn a Host failure payload into one quiet line. */
    function describeSearchFailure(body, status) {
      const code = typeof body?.error === 'string' ? body.error : undefined
      switch (code) {
        case 'invalid-path': return 'Only PDF files can be searched.'
        case 'not-found': case 'missing': return 'The host cannot find this PDF.'
        case 'not-a-file': return 'The host path is not a regular file.'
        case 'file-too-large': case 'too-large': return 'This PDF is too large to search.'
        case 'too-many-pages': return 'This PDF has too many pages to search.'
        case 'no-text-layer': case 'scanned': case 'no-text': return 'This PDF has no text layer (scanned image).'
        case 'extract-failed': return 'The host could not extract text from this PDF.'
        case 'forbidden-host': return 'The host rejected this request.'
        case 'missing-query': return 'Type something to search.'
        case 'query-too-long': return 'Search query is too long (1000 characters max).'
        case 'invalid-limit': return 'The host rejected the search request.'
        default:
          return typeof body?.detail === 'string' && body.detail.trim() !== ''
            ? normalizeSnippet(body.detail, 180)
            : `Search unavailable${status >= 400 ? ` (HTTP ${status})` : ''}.`
      }
    }

    /** Page-lifetime info cache: one `/info` per PDF in ordinary use. */
    const infoCache = new Map()

    /** @returns the cached info, or `undefined`. */
    function cachedInfo(path) {
      return infoCache.get(path)
    }

    /** Remember one info payload, bounding the cache. */
    function rememberInfo(path, info) {
      infoCache.delete(path)
      infoCache.set(path, info)
      while (infoCache.size > INFO_CACHE_LIMIT) {
        const oldest = infoCache.keys().next().value
        infoCache.delete(oldest)
      }
    }

    /**
     * Plugin-wide follow preference.
     *
     * Reporting is a property of the plugin, not of one preview tab: turning it
     * off in one open PDF stops it everywhere. No storage is written.
     */
    let followEnabled = true
    const followSubscribers = new Set()

    /** Publish a new follow preference to every mounted contribution. */
    function publishFollow(next) {
      followEnabled = next === true
      for (const subscriber of followSubscribers) subscriber(followEnabled)
    }

    /** Read the shared follow preference (Session-scope standard React state). */
    function useFollow() {
      const [value, setValue] = useState(followEnabled)
      useEffect(() => {
        followSubscribers.add(setValue)
        setValue(followEnabled)
        return () => {
          followSubscribers.delete(setValue)
        }
      }, [])
      return value
    }

    /**
     * Which mounted contribution answers the next Cmd/Ctrl+Shift+F.
     * Pointing at a preview claims it, exactly like dsh-pdf-search's Ctrl+F.
     */
    let activeOwner

    const CONTROL_STYLE = {
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '1px',
      height: '24px',
      fontSize: '10px',
      lineHeight: '22px',
      color: 'inherit',
      userSelect: 'none',
      whiteSpace: 'nowrap',
    }

    const BUTTON_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '20px',
      height: '20px',
      padding: '0',
      border: 'none',
      borderRadius: '5px',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      font: 'inherit',
      flex: '0 0 auto',
    }

    const INPUT_STYLE = {
      width: '32px',
      height: '20px',
      padding: '0 1px',
      border: '1px solid rgba(128,128,128,.45)',
      borderRadius: '5px',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      textAlign: 'center',
      outline: 'none',
      boxSizing: 'border-box',
      colorScheme: 'light dark',
      userSelect: 'text',
    }

    const BRACKET_STYLE = { opacity: 0.55, fontSize: '10px' }

    const PANEL_STYLE = {
      position: 'fixed',
      top: '56px',
      right: '16px',
      zIndex: 2147483000,
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      width: 'min(360px, calc(100vw - 24px))',
      padding: '8px',
      border: '1px solid rgba(128,128,128,.45)',
      borderRadius: '10px',
      background: 'Canvas',
      color: 'CanvasText',
      boxShadow: '0 10px 32px rgba(0,0,0,.30)',
      font: '12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif',
      colorScheme: 'light dark',
      boxSizing: 'border-box',
    }

    const ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '6px' }
    const MUTED_STYLE = { opacity: 0.7 }
    const WARN_STYLE = { color: '#c69026' }
    const ERROR_STYLE = { color: '#e5534b' }

    const PANEL_INPUT_STYLE = {
      flex: '1 1 auto',
      minWidth: '0',
      height: '24px',
      padding: '0 6px',
      border: '1px solid rgba(128,128,128,.45)',
      borderRadius: '6px',
      background: 'Field',
      color: 'FieldText',
      font: 'inherit',
      colorScheme: 'light dark',
      boxSizing: 'border-box',
      userSelect: 'text',
    }

    const LIST_STYLE = {
      listStyle: 'none',
      margin: '0',
      padding: '0',
      maxHeight: '46vh',
      overflowY: 'auto',
      overscrollBehavior: 'contain',
    }

    const RESULT_ROW_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
      borderTop: '1px solid rgba(128,128,128,.18)',
      padding: '2px 0',
    }

    const RESULT_JUMP_STYLE = {
      flex: '1 1 auto',
      minWidth: '0',
      padding: '3px 2px',
      border: 'none',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      textAlign: 'left',
      cursor: 'pointer',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      textOverflow: 'ellipsis',
      borderRadius: '4px',
    }

    const AI_BUTTON_STYLE = {
      flex: '0 0 auto',
      padding: '2px 5px',
      border: '1px solid rgba(128,128,128,.45)',
      borderRadius: '5px',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      cursor: 'pointer',
      opacity: 0.9,
    }

    const SEARCH_ICON = h('svg', {
      width: 14,
      height: 14,
      viewBox: '0 0 16 16',
      fill: 'none',
      'aria-hidden': 'true',
    },
    h('circle', { cx: 7, cy: 7, r: 4.4, stroke: 'currentColor', strokeWidth: 1.6 }),
    h('path', { d: 'M10.4 10.4 14.2 14.2', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))

    /**
     * Copy plain text, used only when the composer insertion is unavailable.
     * @returns whether the clipboard write succeeded.
     */
    async function copyText(text) {
      try {
        if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return false
        if (typeof navigator.clipboard.writeText !== 'function') return false
        await navigator.clipboard.writeText(text)
        return true
      } catch (_error) {
        return false
      }
    }

    /**
     * The header contribution for one PDF preview.
     * @param props - Session-scope standard props plus the preview's `absolutePath`.
     */
    function PdfReaderAction(props) {
      const absolutePath = typeof props?.absolutePath === 'string' ? props.absolutePath : undefined
      const isPdf = isPdfPath(absolutePath)
      const inputActions = props?.inputActions
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined

      const hostRef = useRef(null)
      const searchButtonRef = useRef(null)
      const searchInputRef = useRef(null)
      const ownerRef = useRef(null)
      if (ownerRef.current === null) ownerRef.current = Symbol('dsh-pdf-reader')
      const focusTimerRef = useRef(null)
      const flashTimerRef = useRef(null)
      const reportAbortRef = useRef(null)
      const reportSeqRef = useRef(0)
      const lastReportedKeyRef = useRef(undefined)
      const reportDebouncerRef = useRef(null)
      if (reportDebouncerRef.current === null) {
        reportDebouncerRef.current = createDebouncer(
          REPORT_DELAY_MS,
          (fn, ms) => globalThis.setTimeout(fn, ms),
          (id) => globalThis.clearTimeout(id),
        )
      }

      const [page, setPage] = useState(1)
      const [sampled, setSampled] = useState(false)
      const [domTotal, setDomTotal] = useState(0)
      const [info, setInfo] = useState(null)
      const [infoError, setInfoError] = useState(null)
      const [editing, setEditing] = useState(false)
      const [typed, setTyped] = useState('')
      const [flash, setFlash] = useState(null)
      const [reportState, setReportState] = useState('idle')
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [hits, setHits] = useState(null)
      const [searching, setSearching] = useState(false)
      const [searchError, setSearchError] = useState(null)
      const follow = useFollow()

      const printedOffset = info?.printedOffset
      const printed = printedPageOf(page, printedOffset)
      const display = printed === undefined ? page : printed
      const total = positiveInteger(info?.pageCount) ? info.pageCount : domTotal

      /** Show a short, quiet status in the header. */
      const flashMessage = (text, tone) => {
        if (flashTimerRef.current !== null) {
          globalThis.clearTimeout(flashTimerRef.current)
          flashTimerRef.current = null
        }
        setFlash({ text, tone: tone ?? 'info' })
        flashTimerRef.current = globalThis.setTimeout(() => {
          flashTimerRef.current = null
          setFlash(null)
        }, FLASH_MS)
      }

      /** Focus the search input; keep the query highlighted for quick replacement. */
      const openSearch = () => {
        setOpen(true)
        if (focusTimerRef.current !== null) globalThis.clearTimeout(focusTimerRef.current)
        focusTimerRef.current = globalThis.setTimeout(() => {
          focusTimerRef.current = null
          searchInputRef.current?.focus()
          searchInputRef.current?.select()
        }, 0)
      }

      /** Close the panel and give focus back to the header button. */
      const closeSearch = () => {
        setOpen(false)
        if (focusTimerRef.current !== null) {
          globalThis.clearTimeout(focusTimerRef.current)
          focusTimerRef.current = null
        }
        searchButtonRef.current?.focus()
      }

      /**
       * Deliver a composer reference.
       * Primary path is the undoable insertion at the caret; when the composer
       * is busy or absent, copy instead of clobbering the draft.
       */
      const deliverReference = (text, label) => {
        if (insertComposerText(inputActions, text)) {
          flashMessage(label, 'ok')
          return
        }
        void copyText(text).then((copied) => {
          if (hostRef.current === null) return
          flashMessage(copied ? `${label} (copied)` : 'Composer busy', copied ? 'ok' : 'warn')
        })
      }

      /** Scroll a physical page into view and update the readout immediately. */
      const jumpTo = (target) => {
        if (!positiveInteger(target)) return false
        if (total > 0 && target > total) {
          flashMessage(`No page ${target}`, 'warn')
          return false
        }
        const pane = resolvePane(hostRef.current)
        if (pane === undefined) {
          flashMessage('Preview not ready', 'warn')
          return false
        }
        const scrollport = resolveScrollport(pane)
        if (!scrollPageIntoView(pane, scrollport, target)) {
          flashMessage(`Page ${displayPage(target, printedOffset)} is not rendered`, 'warn')
          return false
        }
        setPage(target)
        setSampled(true)
        flashMessage(`p.${displayPage(target, printedOffset)}`, 'ok')
        return true
      }

      /** Commit the page box; plain numbers mean printed pages when known. */
      const commitJump = () => {
        const target = parsePageInput(typed, { printedOffset, pageCount: total })
        if (target === undefined) {
          const shown = typed.trim() === '' ? 'No page' : `No page ${typed.trim()}`
          flashMessage(shown, 'warn')
          return false
        }
        if (!jumpTo(target)) return false
        setEditing(false)
        return true
      }

      /** Step one physical page; the readout still shows the printed label. */
      const step = (delta) => {
        const next = page + delta
        if (next < 1) return
        if (total > 0 && next > total) return
        jumpTo(next)
      }

      // Reset every path-scoped piece of state when the preview switches files.
      useEffect(() => {
        setPage(1)
        setSampled(false)
        setDomTotal(0)
        setInfo(null)
        setInfoError(null)
        setEditing(false)
        setTyped('')
        setFlash(null)
        setReportState('idle')
        setOpen(false)
        setQuery('')
        setHits(null)
        setSearching(false)
        setSearchError(null)
        lastReportedKeyRef.current = undefined
        reportAbortRef.current?.abort()
        if (focusTimerRef.current !== null) {
          globalThis.clearTimeout(focusTimerRef.current)
          focusTimerRef.current = null
        }
        if (flashTimerRef.current !== null) {
          globalThis.clearTimeout(flashTimerRef.current)
          flashTimerRef.current = null
        }
      }, [absolutePath])

      // One `/info` per PDF, cached for the page lifetime.
      useEffect(() => {
        if (!isPdf || absolutePath === undefined) {
          setInfo(null)
          setInfoError(null)
          return undefined
        }
        const cached = cachedInfo(absolutePath)
        if (cached !== undefined) {
          setInfo(cached)
          setInfoError(null)
          return undefined
        }
        setInfo(null)
        setInfoError(null)
        const controller = new AbortController()
        let disposed = false
        let timedOut = false
        const timer = globalThis.setTimeout(() => {
          timedOut = true
          controller.abort()
        }, INFO_TIMEOUT_MS)
        const load = async () => {
          try {
            const { status, body } = await fetchJson(
              `${INFO_ROUTE}?path=${encodeURIComponent(absolutePath)}`,
              { headers: { accept: 'application/json' }, signal: controller.signal },
            )
            if (disposed) return
            const parsed = normalizeInfo(body)
            if (parsed === undefined) {
              setInfoError(`info unavailable${status >= 400 ? ` (HTTP ${status})` : ''}`)
              return
            }
            rememberInfo(absolutePath, parsed)
            setInfo(parsed)
            setInfoError(null)
          } catch (error) {
            if (disposed || isAbortError(error)) return
            setInfoError(timedOut ? 'info timed out' : 'info unavailable')
          } finally {
            globalThis.clearTimeout(timer)
          }
        }
        void load()
        return () => {
          disposed = true
          globalThis.clearTimeout(timer)
          controller.abort()
        }
      }, [isPdf, absolutePath])

      // Bind the header to its preview body, scrollport, and page geometry.
      //
      // Geometry is measured once per layout change (ResizeObserver / resize /
      // visibility), never per scroll: scroll handling is one rAF and a binary
      // search over cached page tops, so a 410-page book stays cheap.
      useEffect(() => {
        if (!isPdf) return undefined
        const host = hostRef.current
        if (host === null) return undefined

        let disposed = false
        let pane
        let scrollport
        let section
        let rootObserver
        let resizeObserver
        let retryTimer
        let retryCount = 0
        let geometry = []
        let lastPage
        const view = typeof window !== 'undefined' ? window : globalThis

        const requestFrame = typeof view.requestAnimationFrame === 'function'
          ? (fn) => view.requestAnimationFrame(fn)
          : (fn) => globalThis.setTimeout(fn, 16)
        const cancelFrame = typeof view.cancelAnimationFrame === 'function'
          ? (id) => view.cancelAnimationFrame(id)
          : (id) => globalThis.clearTimeout(id)
        const throttle = createRafThrottle(requestFrame, cancelFrame)
        const measureDebouncer = createDebouncer(
          120,
          (fn, ms) => globalThis.setTimeout(fn, ms),
          (id) => globalThis.clearTimeout(id),
        )
        const structureDebouncer = createDebouncer(
          250,
          (fn, ms) => globalThis.setTimeout(fn, ms),
          (id) => globalThis.clearTimeout(id),
        )

        const sample = () => {
          if (disposed || scrollport === undefined) return
          if (geometry.length === 0) {
            measureDebouncer.schedule(measure)
            return
          }
          let height = scrollport.clientHeight
          if (!(typeof height === 'number' && height > 0)) {
            try {
              height = scrollport.getBoundingClientRect().height
            } catch (_error) {
              height = 0
            }
          }
          let top = scrollport.scrollTop
          if (typeof top !== 'number' || !Number.isFinite(top)) top = 0
          const next = pickPage(geometry, { top, height })
          if (next === undefined || next === lastPage) return
          lastPage = next
          setPage(next)
          setSampled(true)
        }

        const measure = () => {
          if (disposed) return
          const currentPane = resolvePane(host)
          if (currentPane === undefined) {
            scheduleRetry()
            return
          }
          const currentScrollport = resolveScrollport(currentPane)
          const currentSection = currentPane.querySelector(`[${PDF_SECTION_ATTR}]`)
          if (currentPane !== pane || currentScrollport !== scrollport || currentSection !== section) {
            bind(currentPane, currentScrollport, currentSection)
            return
          }
          const pages = pageElements(currentPane)
          const nextGeometry = []
          try {
            const portRect = currentScrollport === undefined ? { top: 0 } : currentScrollport.getBoundingClientRect()
            const base = currentScrollport === undefined ? 0 : currentScrollport.scrollTop
            for (const entry of pages) {
              const rect = entry.element.getBoundingClientRect()
              nextGeometry.push({ number: entry.number, top: rect.top - portRect.top + base })
            }
          } catch (_error) {
            // A renderer mid-teardown leaves the previous cache in place; the
            // ResizeObserver retries once layout is available again.
            return
          }
          geometry = nextGeometry
          const last = nextGeometry.length === 0 ? 0 : nextGeometry[nextGeometry.length - 1].number
          setDomTotal(last)
          sample()
        }

        const onScroll = () => {
          throttle.schedule(sample)
        }

        const onResize = () => {
          if (disposed) return
          measureDebouncer.schedule(() => {
            measure()
            sample()
          })
        }

        const onVisibility = () => {
          if (!disposed && document.visibilityState === 'visible') onResize()
        }

        /** Re-resolve structure after a DOM mutation; page renders alone are ignored. */
        const syncStructure = () => {
          if (disposed) return
          const nextPane = resolvePane(host)
          if (nextPane === undefined) return
          const nextScrollport = resolveScrollport(nextPane)
          const nextSection = nextPane.querySelector(`[${PDF_SECTION_ATTR}]`)
          if (nextPane !== pane || nextScrollport !== scrollport || nextSection !== section) {
            bind(nextPane, nextScrollport, nextSection)
          }
        }

        const observeStructure = (target) => {
          rootObserver?.disconnect()
          rootObserver = undefined
          if (typeof MutationObserver !== 'function' || target === null || target === undefined) return
          rootObserver = new MutationObserver(() => {
            structureDebouncer.schedule(syncStructure)
          })
          rootObserver.observe(target, { childList: true, subtree: true })
        }

        const observeSize = (target) => {
          resizeObserver?.disconnect()
          resizeObserver = undefined
          if (typeof ResizeObserver !== 'function') return
          resizeObserver = new ResizeObserver(onResize)
          if (target !== null && target !== undefined) resizeObserver.observe(target)
        }

        const detach = () => {
          scrollport?.removeEventListener('scroll', onScroll)
          pane?.removeEventListener('scroll', onScroll, true)
          view.removeEventListener('resize', onResize)
          document.removeEventListener('visibilitychange', onVisibility)
          rootObserver?.disconnect()
          rootObserver = undefined
          resizeObserver?.disconnect()
          resizeObserver = undefined
        }

        const bind = (nextPane, nextScrollport, nextSection) => {
          detach()
          pane = nextPane
          scrollport = nextScrollport
          section = nextSection
          geometry = []
          lastPage = undefined
          if (pane !== undefined) {
            pane.addEventListener('scroll', onScroll, true)
            view.addEventListener('resize', onResize)
            document.addEventListener('visibilitychange', onVisibility)
            observeStructure(pane.parentElement ?? host.parentElement ?? pane)
            observeSize(nextScrollport ?? pane)
            if (typeof ResizeObserver === 'function' && nextSection !== null && nextSection !== undefined) {
              resizeObserver.observe(nextSection)
            }
          }
          if (nextScrollport !== undefined) {
            nextScrollport.addEventListener('scroll', onScroll, { passive: true })
          }
          measure()
        }

        const scheduleRetry = () => {
          if (disposed || retryTimer !== undefined || retryCount >= 40) return
          retryCount += 1
          retryTimer = globalThis.setTimeout(() => {
            retryTimer = undefined
            attempt()
          }, 200)
        }

        const attempt = () => {
          if (disposed) return
          const nextPane = resolvePane(host)
          if (nextPane === undefined) {
            scheduleRetry()
            return
          }
          const nextScrollport = resolveScrollport(nextPane)
          const nextSection = nextPane.querySelector(`[${PDF_SECTION_ATTR}]`)
          bind(nextPane, nextScrollport, nextSection)
        }

        attempt()
        return () => {
          disposed = true
          throttle.cancel()
          measureDebouncer.cancel()
          structureDebouncer.cancel()
          if (retryTimer !== undefined) globalThis.clearTimeout(retryTimer)
          detach()
        }
      }, [isPdf, absolutePath])

      // Debounced AI-context reporting. One timer, one in-flight POST, abort on
      // page change, toggle-off, path change, or unmount.
      useEffect(() => {
        if (!isPdf || absolutePath === undefined || !sampled) return undefined
        const key = `${absolutePath}|${page}|${printed === undefined ? '' : printed}|${sessionId ?? ''}`
        if (!follow) {
          reportDebouncerRef.current.cancel()
          reportAbortRef.current?.abort()
          lastReportedKeyRef.current = undefined
          setReportState('off')
          return undefined
        }
        if (lastReportedKeyRef.current === key) {
          // The host already has this exact page. This also repairs a state
          // left at "sending" when a rapid detour aborted a newer request.
          setReportState('ok')
          return undefined
        }
        let disposed = false
        reportDebouncerRef.current.schedule(() => {
          if (disposed) return
          if (typeof fetch !== 'function') {
            setReportState('error')
            return
          }
          const controller = new AbortController()
          reportAbortRef.current?.abort()
          reportAbortRef.current = controller
          const seq = reportSeqRef.current + 1
          reportSeqRef.current = seq
          let timedOut = false
          const timer = globalThis.setTimeout(() => {
            timedOut = true
            controller.abort()
          }, REPORT_TIMEOUT_MS)
          const body = { path: absolutePath, pdfPage: page }
          if (printed !== undefined) body.printedPage = printed
          if (sessionId !== undefined) body.sessionId = sessionId
          setReportState('sending')
          fetch(CURRENT_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
            keepalive: true,
          })
            .then(async (response) => {
              const payload = await response.json().catch(() => null)
              if (!response.ok || payload?.ok !== true) throw new Error(`HTTP ${response.status}`)
              return payload
            })
            .then(() => {
              if (disposed || seq !== reportSeqRef.current) return
              lastReportedKeyRef.current = key
              setReportState('ok')
            })
            .catch((error) => {
              if (disposed || seq !== reportSeqRef.current) return
              if (isAbortError(error) && !timedOut) return
              setReportState('error')
            })
            .finally(() => {
              globalThis.clearTimeout(timer)
              if (reportAbortRef.current === controller) reportAbortRef.current = null
            })
        })
        return () => {
          disposed = true
          reportDebouncerRef.current.cancel()
          reportAbortRef.current?.abort()
        }
      }, [isPdf, absolutePath, sampled, page, printed, sessionId, follow])

      // Search: type, wait 220 ms, query the Host route, cancel the stale query.
      useEffect(() => {
        if (!open || !isPdf || absolutePath === undefined) return undefined
        const needle = query.trim()
        if (needle === '') {
          setHits(null)
          setSearchError(null)
          setSearching(false)
          return undefined
        }
        setSearching(true)
        setSearchError(null)
        let disposed = false
        let timedOut = false
        let timer
        const controller = new AbortController()
        const start = () => {
          if (disposed) return
          timer = globalThis.setTimeout(() => {
            timedOut = true
            controller.abort()
          }, SEARCH_TIMEOUT_MS)
          const url = `${SEARCH_ROUTE}?path=${encodeURIComponent(absolutePath)}`
            + `&q=${encodeURIComponent(needle)}&ignoreCase=1&limit=${SEARCH_LIMIT}`
          fetchJson(url, { headers: { accept: 'application/json' }, signal: controller.signal })
            .then(({ status, body }) => {
              if (disposed) return
              if (body === null || typeof body !== 'object' || body.ok !== true) {
                setHits([])
                setSearchError(describeSearchFailure(body, status))
                return
              }
              const list = Array.isArray(body.hits)
                ? body.hits.map(normalizeHit).filter((hit) => hit !== undefined)
                : []
              setHits(list)
              setSearchError(null)
            })
            .catch((error) => {
              if (disposed || (isAbortError(error) && !timedOut)) return
              setHits([])
              setSearchError(timedOut ? 'Search timed out.' : 'Search unavailable.')
            })
            .finally(() => {
              globalThis.clearTimeout(timer)
              if (!disposed) setSearching(false)
            })
        }
        const debounce = globalThis.setTimeout(start, SEARCH_DELAY_MS)
        return () => {
          disposed = true
          globalThis.clearTimeout(debounce)
          if (timer !== undefined) globalThis.clearTimeout(timer)
          controller.abort()
        }
      }, [open, isPdf, absolutePath, query])

      // Cmd/Ctrl+Shift+F opens search. Plain Cmd/Ctrl+F is deliberately left
      // alone: dsh-pdf-search owns it and the browser find bar remains intact.
      useEffect(() => {
        if (!isPdf) return undefined
        const owner = ownerRef.current
        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.repeat || event.isComposing) return
          if (!(event.metaKey || event.ctrlKey) || event.altKey || !event.shiftKey) return
          if (String(event.key).toLowerCase() !== 'f') return
          if (activeOwner === undefined) activeOwner = owner
          if (activeOwner !== owner) return
          event.preventDefault()
          event.stopPropagation()
          openSearch()
        }
        const claim = () => {
          activeOwner = owner
        }
        const host = hostRef.current
        host?.addEventListener('pointerdown', claim)
        host?.addEventListener('focusin', claim)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          host?.removeEventListener('pointerdown', claim)
          host?.removeEventListener('focusin', claim)
          if (activeOwner === owner) activeOwner = undefined
        }
      }, [isPdf])

      // Timers that outlive a render and must not outlive the component.
      useEffect(() => () => {
        if (focusTimerRef.current !== null) globalThis.clearTimeout(focusTimerRef.current)
        if (flashTimerRef.current !== null) globalThis.clearTimeout(flashTimerRef.current)
      }, [])

      if (!isPdf) return null

      const pageTitle = printedOffset === undefined
        ? `PDF page ${page}. Type a page number and press Enter; Cmd/Ctrl+Shift+F searches.`
        : printed === undefined
          ? `PDF page ${page} (front matter has no numeric printed label). `
            + 'Type a printed page and press Enter; prefix p for a PDF page.'
          : `Printed page ${printed} = PDF page ${page}. `
            + 'Type a printed page and press Enter; prefix p for a PDF page.'
      const followTitle = !follow
        ? 'AI context: off — the host is not told which page you are on'
        : reportState === 'sending'
          ? `AI context: on — reporting p.${display}…`
          : reportState === 'ok'
            ? `AI context: on — host knows p.${display}`
            : reportState === 'error'
              ? 'AI context: on — host route /dsh-pdf-reader/current is unavailable'
              : `AI context: on — the host will be told the current page (p.${display})`
      const dotColor = !follow
        ? 'currentColor'
        : reportState === 'error'
          ? '#e5534b'
          : reportState === 'ok'
            ? '#3fb950'
            : reportState === 'sending'
              ? '#c69026'
              : 'currentColor'

      const controls = [
        h('button', {
          key: 'prev',
          type: 'button',
          title: 'Previous page',
          'aria-label': 'Previous page',
          'data-dsh-pdf-reader': 'prev',
          disabled: page <= 1,
          onClick: () => {
            step(-1)
          },
          style: { ...BUTTON_STYLE, opacity: page <= 1 ? 0.35 : 1 },
        }, '‹'),
        h('span', {
          key: 'readout',
          style: { display: 'inline-flex', alignItems: 'center', gap: '1px', flex: '0 0 auto' },
        },
        h('span', { style: BRACKET_STYLE, 'aria-hidden': 'true' }, '['),
        h('input', {
          type: 'text',
          inputMode: 'numeric',
          autoComplete: 'off',
          spellCheck: false,
          maxLength: 12,
          value: editing ? typed : String(display),
          'aria-label': printedOffset === undefined
            ? `PDF page (${page} of ${total > 0 ? total : 'unknown'})`
            : `Printed page (PDF page ${page} of ${total > 0 ? total : 'unknown'})`,
          title: pageTitle,
          'data-dsh-pdf-reader': 'page',
          style: INPUT_STYLE,
          onFocus: (event) => {
            setEditing(true)
            setTyped(String(display))
            event.currentTarget.select()
          },
          onChange: (event) => {
            setTyped(String(event.target.value))
          },
          onBlur: () => {
            setEditing(false)
          },
          onKeyDown: (event) => {
            if (event.isComposing) return
            if (event.key === 'Enter') {
              event.preventDefault()
              if (commitJump()) event.currentTarget.blur()
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setEditing(false)
              setTyped('')
              event.currentTarget.blur()
            }
          },
        }),
        h('span', { style: BRACKET_STYLE, 'aria-hidden': 'true' }, ']'),
        h('span', {
          style: { opacity: 0.55, marginLeft: '1px' },
          title: infoError ?? undefined,
        }, `/ ${total > 0 ? total : '?'}`)),
        h('button', {
          key: 'next',
          type: 'button',
          title: 'Next page',
          'aria-label': 'Next page',
          'data-dsh-pdf-reader': 'next',
          disabled: total > 0 && page >= total,
          onClick: () => {
            step(1)
          },
          style: { ...BUTTON_STYLE, opacity: total > 0 && page >= total ? 0.35 : 1 },
        }, '›'),
        h('button', {
          key: 'search',
          ref: searchButtonRef,
          type: 'button',
          title: 'Search this PDF (Cmd/Ctrl+Shift+F)',
          'aria-label': 'Search this PDF',
          'aria-expanded': open,
          'data-dsh-pdf-reader': 'search',
          onClick: () => {
            if (open) closeSearch()
            else openSearch()
          },
          style: BUTTON_STYLE,
        }, SEARCH_ICON),
        h('button', {
          key: 'share',
          type: 'button',
          title: `Insert [PDF p.${display}] into the chat`,
          'aria-label': 'Insert this page reference into the chat',
          'data-dsh-pdf-reader': 'share',
          onClick: () => {
            deliverReference(buildShareReference(page, printedOffset), 'Inserted')
          },
          style: BUTTON_STYLE,
        }, h('span', { 'aria-hidden': 'true', style: { fontSize: '14px' } }, '↗')),
        h('button', {
          key: 'follow',
          type: 'button',
          title: followTitle,
          'aria-label': 'AI context reporting',
          'aria-pressed': follow,
          'data-dsh-pdf-reader': 'follow',
          onClick: () => {
            publishFollow(!follow)
          },
          style: {
            ...BUTTON_STYLE,
            width: '24px',
            gap: '1px',
            opacity: follow ? 1 : 0.45,
          },
        },
        h('span', { 'aria-hidden': 'true', style: { fontSize: '8px', letterSpacing: '-.02em' } }, 'AI'),
        h('span', {
          'aria-hidden': 'true',
          style: {
            width: '5px',
            height: '5px',
            borderRadius: '50%',
            background: dotColor,
            display: 'inline-block',
            flex: '0 0 auto',
          },
        })),
      ]

      if (flash !== null) {
        controls.push(h('span', {
          key: 'flash',
          'aria-live': 'polite',
          title: flash.text,
          style: {
            position: 'absolute',
            top: '24px',
            right: '0',
            zIndex: 1,
            maxWidth: '180px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            padding: '1px 4px',
            border: '1px solid rgba(128,128,128,.35)',
            borderRadius: '4px',
            background: 'Canvas',
            color: 'CanvasText',
            fontSize: '10px',
            lineHeight: '14px',
            opacity: 0.95,
            ...(flash.tone === 'warn' ? WARN_STYLE : flash.tone === 'ok' ? { color: '#3fb950' } : {}),
          },
        }, flash.text))
      }

      let panel = null
      if (open) {
        const needle = query.trim()
        const statusText = searching
          ? 'Searching…'
          : searchError !== null
            ? searchError
            : needle === ''
              ? `${total > 0 ? total : '?'} pages · type to search`
              : hits === null
                ? ''
                : hits.length === 0
                  ? 'No matches — scanned PDFs have no text layer.'
                  : `${hits.length}${hits.length >= SEARCH_LIMIT ? '+' : ''} result${hits.length === 1 ? '' : 's'}`
        const list = hits !== null && hits.length > 0
          ? h('ul', { style: LIST_STYLE }, hits.map((hit, index) => {
            const label = searchResultLabel(hit)
            const snippet = normalizeSnippet(hit.snippet, 140)
            return h('li', {
              key: `${hit.pdf}:${index}`,
              style: RESULT_ROW_STYLE,
            },
            h('button', {
              type: 'button',
              title: hit.printed === undefined
                ? `Jump to PDF page ${hit.pdf}`
                : `Jump to printed p.${hit.printed} (PDF p.${hit.pdf})`,
              'data-dsh-pdf-reader': 'result',
              onClick: () => {
                jumpTo(hit.pdf)
              },
              style: RESULT_JUMP_STYLE,
            }, snippet === '' ? label : `${label} — ${snippet}`),
            h('button', {
              type: 'button',
              title: `Insert “${buildSearchReference(hit)}” into the chat`,
              'data-dsh-pdf-reader': 'result-ai',
              onClick: () => {
                deliverReference(buildSearchReference(hit), 'Inserted')
              },
              style: AI_BUTTON_STYLE,
            }, '→ AI'))
          }))
          : null
        panel = h('div', {
          key: 'panel',
          style: PANEL_STYLE,
          role: 'dialog',
          'aria-label': 'Search this PDF',
          'data-dsh-pdf-reader': 'panel',
          onKeyDown: (event) => {
            if (event.isComposing) return
            event.stopPropagation()
            if (event.key === 'Escape') {
              event.preventDefault()
              closeSearch()
            }
          },
        },
        h('div', { style: ROW_STYLE },
          h('input', {
            ref: searchInputRef,
            type: 'search',
            value: query,
            placeholder: 'Search this PDF',
            'aria-label': 'Search this PDF',
            spellCheck: false,
            autoComplete: 'off',
            maxLength: 1000,
            style: PANEL_INPUT_STYLE,
            onChange: (event) => {
              setQuery(String(event.target.value))
            },
            onKeyDown: (event) => {
              if (event.isComposing) return
              if (event.key === 'Enter' && hits !== null && hits.length > 0) {
                event.preventDefault()
                jumpTo(hits[0].pdf)
              }
            },
          }),
          h('button', {
            type: 'button',
            title: 'Close search (Esc)',
            'aria-label': 'Close search',
            onClick: closeSearch,
            style: BUTTON_STYLE,
          }, '✕')),
        h('div', {
          'aria-live': 'polite',
          style: {
            minHeight: '18px',
            ...(searchError !== null ? WARN_STYLE : MUTED_STYLE),
          },
        }, statusText),
        list,
        h('div', { style: { ...MUTED_STYLE, fontSize: '10px' } },
          'Click a page to jump · → AI inserts a reference at the caret'))
      }

      controls.push(panel)

      return h('span', {
        ref: hostRef,
        style: CONTROL_STYLE,
        'data-dsh-pdf-reader': 'controls',
      }, ...controls)
    }

    /** Required browser services: the slot registry. */
    const inject = ['slots']

    /**
     * Register the document-header contribution.
     * @param ctx - client root context carrying the slot registry.
     */
    function apply(ctx) {
      ctx.effect(
        () => ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
          name: 'sidebar.right.tab.document.actions',
          id: 'pdf-reader-tools',
          order: -6,
        }, PdfReaderAction)),
        'dsh-pdf-reader: PDF page tools',
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.PdfReaderAction = PdfReaderAction
    // Pure helpers exposed for the headless tests only; the loader ignores them.
    exports.__test = {
      AI_BUTTON_STYLE,
      PANEL_STYLE,
      buildSearchReference,
      buildShareReference,
      cachedInfo,
      copyText,
      createDebouncer,
      createRafThrottle,
      describeSearchFailure,
      displayPage,
      fetchJson,
      infoCache,
      insertComposerText,
      isPdfPath,
      normalizeInfo,
      normalizeSnippet,
      pageElements,
      parsePageInput,
      pickPage,
      positiveInteger,
      printedPageOf,
      rememberInfo,
      resolvePane,
      resolveScrollport,
      scrollPageIntoView,
      searchResultLabel,
      searchResultPage,
    }
    return module.exports
  },
})
