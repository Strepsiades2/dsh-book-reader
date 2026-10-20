/**
 * dsh-book-reader — browser half.
 *
 * Decorates DSH's official PDF preview; it never replaces the renderer:
 *   - current-page readout, prev/next page, and a page-jump box;
 *   - a find bar (Cmd/Ctrl+F) backed by the Host text route, with in-page
 *     highlights and sequential previous/next navigation between occurrences;
 *   - debounced current-page reporting for AI context, with an on/off toggle.
 *
 * The contribution mounts into the preview's own header slot
 * `sidebar.right.tab.document.actions`, which the preview declares as a
 * Session-scoped list and passes `{ absolutePath }` to. Session-scoped slots
 * also receive the standard `sessionId`, used only to tag the current-page
 * reports; the plugin never writes to the chat composer.
 *
 * The bundle is the module-loader factory shape used by the profile:
 * `window.__ModuleLoader__.load({ id, factory })`, React is the only external.
 */
window.__ModuleLoader__.load({
  id: 'dsh-book-reader',
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
    const VIEW_ROUTE = '/dsh-pdf-reader/view'

    /** DOM markers owned by the official preview (same ones dsh-pdf-search uses). */
    const PANE_ATTR = 'data-textpreview-body'
    const SCROLL_ATTR = 'data-document-zoom-scrollport'
    const ZOOM_FRAME_ATTR = 'data-document-zoom-frame'
    const ZOOM_MODE_ATTR = 'data-document-zoom-mode'
    const ZOOM_VAR = '--document-zoom'
    const PAGE_ATTR = 'data-pdf-page'
    const PDF_SECTION_ATTR = 'data-pdf-preview'
    /** Text-layer container created by pdf.js TextLayerBuilder for one page. */
    const TEXT_LAYER_ATTR = 'data-pdf-text'

    /** Timing. Reporting is the only debounced write; scrolling uses one rAF. */
    const REPORT_DELAY_MS = 400
    const SEARCH_DELAY_MS = 220
    const INFO_TIMEOUT_MS = 30_000
    const SEARCH_TIMEOUT_MS = 60_000
    const REPORT_TIMEOUT_MS = 6_000
    const FLASH_MS = 1_600
    const SEARCH_LIMIT = 100
    const INFO_CACHE_LIMIT = 16

    /**
     * Search highlighting.
     *
     * The panel owns two document-wide CSS Custom Highlights: one for every
     * match on the pages the Host reported, and one for the occurrence the
     * counter is on. Pages render lazily and re-render on zoom, so the text
     * layer is retried for about three seconds and then observed for replacement.
     */
    const SEARCH_HIGHLIGHT_NAME = 'dsh-book-reader-search'
    const SEARCH_ACTIVE_HIGHLIGHT_NAME = 'dsh-book-reader-search-active'
    const SEARCH_HIT_CLASS = 'dsh-book-reader-search-hit'
    const SEARCH_ACTIVE_HIT_CLASS = 'dsh-book-reader-search-active-hit'
    const SEARCH_HIGHLIGHT_STYLE_ID = 'dsh-book-reader-search-highlight-style'
    const SEARCH_HIGHLIGHT_RETRY_MS = 150
    const SEARCH_HIGHLIGHT_RETRY_LIMIT = 20
    const SEARCH_HIGHLIGHT_REBUILD_MS = 60

    /**
     * Reading-position memory timing.
     *
     * Restoring is best effort and must not block the preview: the saved view is
     * fetched in parallel, then the structure/page markers are retried for about
     * eight seconds. Saving starts only after restore finished (success or
     * failure) so opening a book cannot overwrite its saved page with page 1.
     * The save debounce is deliberately longer than the report debounce so a
     * scroll settles before either write happens.
     */
    const VIEW_TIMEOUT_MS = 6_000
    const VIEW_SAVE_DELAY_MS = 500
    const VIEW_RETRY_MS = 200
    const VIEW_RETRY_LIMIT = 40
    const VIEW_REAPPLY_MS = 300
    const VIEW_ZOOM_STEP_MS = 50
    const VIEW_ZOOM_SETTLE_MS = 160
    const VIEW_ZOOM_EVENT_LIMIT = 20
    const VIEW_ZOOM_TOLERANCE = 0.02
    const VIEW_ZOOM_MIN = 0.25
    const VIEW_ZOOM_MAX = 4

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

    /** Collapse whitespace and bound a diagnostic detail for the quiet panel. */
    function normalizeSnippet(value, limit = 160) {
      const source = typeof value === 'string' ? value : ''
      const clean = source.replace(/\s+/gu, ' ').trim()
      const max = positiveInteger(limit) ? limit : 160
      if (clean.length <= max) return clean
      return `${clean.slice(0, max - 1).trimEnd()}…`
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
     * Case-fold text one UTF-16 code unit at a time.
     *
     * Search offsets have to stay 1:1 with the text layer, so characters whose
     * lowercase form changes length (such as `İ`) keep their original form. The
     * query is folded with the same function, which mirrors the Host's
     * case-insensitive literal search closely enough to number occurrences.
     * @param value - text to fold.
     * @returns the folded text, same length as the input.
     */
    function foldSearchText(value) {
      const text = typeof value === 'string' ? value : String(value ?? '')
      let folded = ''
      for (let at = 0; at < text.length; at += 1) {
        const char = text[at]
        let lower = char
        try {
          lower = char.toLowerCase()
        } catch (_error) {
          lower = char
        }
        folded += typeof lower === 'string' && lower.length === 1 ? lower : char
      }
      return folded
    }

    /**
     * Every non-empty text node under one element, in document order.
     * @param root - text-layer container.
     * @returns text nodes, or an empty array when the DOM cannot be walked.
     */
    function collectTextNodes(root) {
      const nodes = []
      if (root === null || root === undefined) return nodes
      const documentRef = root.ownerDocument
      if (documentRef === null || documentRef === undefined) return nodes
      if (typeof documentRef.createTreeWalker !== 'function') return nodes
      try {
        // 4 is NodeFilter.SHOW_TEXT; pdf.js text layers contain no other nodes
        // that matter, and this avoids depending on the global NodeFilter.
        const walker = documentRef.createTreeWalker(root, 4)
        let node = walker.nextNode()
        while (node !== null) {
          const text = node.nodeValue
          if (typeof text === 'string' && text !== '') nodes.push(node)
          node = walker.nextNode()
        }
      } catch (_error) {
        return []
      }
      return nodes
    }

    /**
     * Locate literal case-insensitive occurrences across a run of text nodes.
     *
     * The text layer is split into arbitrarily many spans, so concatenate the
     * node values and keep each node's start offset. A match may therefore span
     * multiple nodes; `Range` creation maps both ends back to the right node.
     * @param nodes - text nodes in document order.
     * @param needle - literal query (already trimmed).
     * @returns `{ nodes, starts, matches }`, or `undefined` when there is no text.
     */
    function matchTextNodes(nodes, needle) {
      const foldedNeedle = foldSearchText(needle)
      if (nodes.length === 0 || foldedNeedle === '') return undefined
      const starts = []
      let text = ''
      for (const node of nodes) {
        starts.push(text.length)
        text += typeof node.nodeValue === 'string' ? node.nodeValue : ''
      }
      const folded = foldSearchText(text)
      const matches = []
      let from = 0
      for (;;) {
        const at = folded.indexOf(foldedNeedle, from)
        if (at < 0) break
        matches.push({ start: at, end: at + foldedNeedle.length })
        from = at + Math.max(1, foldedNeedle.length)
      }
      if (matches.length === 0) return undefined
      return { nodes, starts, matches }
    }

    /**
     * @returns the text node and offset containing one global text offset.
     */
    function locateTextOffset(nodes, starts, offset) {
      let low = 0
      let high = starts.length - 1
      let found = 0
      while (low <= high) {
        const mid = (low + high) >> 1
        if (starts[mid] <= offset) {
          found = mid
          low = mid + 1
        } else {
          high = mid - 1
        }
      }
      const node = nodes[found]
      const length = typeof node.nodeValue === 'string' ? node.nodeValue.length : 0
      return { node, offset: Math.max(0, Math.min(offset - starts[found], length)) }
    }

    /** Build a DOM Range for one match, or `undefined` when it cannot be made. */
    function createTextRange(documentRef, nodes, starts, match) {
      if (documentRef === null || documentRef === undefined || typeof documentRef.createRange !== 'function') {
        return undefined
      }
      try {
        const first = locateTextOffset(nodes, starts, match.start)
        const last = locateTextOffset(nodes, starts, match.end)
        const range = documentRef.createRange()
        range.setStart(first.node, first.offset)
        range.setEnd(last.node, last.offset)
        return range
      } catch (_error) {
        return undefined
      }
    }

    /**
     * Add the highlight stylesheet once per document.
     *
     * Both APIs are styled from the same palette: translucent yellow for every
     * match, a stronger orange for the current one. `rgba` keeps them readable
     * over light and dark themes and avoids depending on theme variables a
     * browser might not resolve inside `::highlight`.
     */
    function ensureSearchHighlightStyle(documentRef) {
      if (documentRef === null || documentRef === undefined) return
      if (typeof documentRef.createElement !== 'function') return
      try {
        if (typeof documentRef.getElementById === 'function'
          && documentRef.getElementById(SEARCH_HIGHLIGHT_STYLE_ID) !== null) {
          return
        }
        const style = documentRef.createElement('style')
        style.id = SEARCH_HIGHLIGHT_STYLE_ID
        style.textContent = [
          `::highlight(${SEARCH_HIGHLIGHT_NAME}) { background-color: rgba(255, 213, 0, 0.42); color: inherit; }`,
          `::highlight(${SEARCH_ACTIVE_HIGHLIGHT_NAME}) { background-color: rgba(255, 138, 0, 0.68); color: inherit; }`,
          `.${SEARCH_HIT_CLASS} { background-color: rgba(255, 213, 0, 0.42); color: inherit; }`,
          `.${SEARCH_ACTIVE_HIT_CLASS} { background-color: rgba(255, 138, 0, 0.68); color: inherit; }`,
        ].join('\n')
        const parent = documentRef.head ?? documentRef.documentElement
        if (parent !== null && parent !== undefined && typeof parent.appendChild === 'function') {
          parent.appendChild(style)
        }
      } catch (_error) {
        // Highlight color is decorative: a missing <style> must never break search.
      }
    }

    /**
     * Detect the CSS Custom Highlight API.
     * @returns `{ registry, Highlight }`, or `undefined` when unavailable.
     */
    function searchHighlightSupport() {
      const candidates = []
      try {
        if (typeof window !== 'undefined' && window !== null) candidates.push(window)
      } catch (_error) {
        // No window in some headless environments; globalThis is enough.
      }
      candidates.push(globalThis)
      for (const candidate of candidates) {
        try {
          const registry = candidate?.CSS?.highlights
          const HighlightClass = candidate?.Highlight
          if (registry !== null && registry !== undefined
            && typeof registry.set === 'function'
            && typeof registry.delete === 'function'
            && typeof HighlightClass === 'function') {
            return { registry, Highlight: HighlightClass }
          }
        } catch (_error) {
          // Try the next global.
        }
      }
      return undefined
    }

    /**
     * Remove both highlight layers and any fallback span classes.
     * @param pane - preview body, when still known.
     */
    function clearSearchHighlights(pane) {
      try {
        const support = searchHighlightSupport()
        if (support !== undefined) {
          support.registry.delete(SEARCH_HIGHLIGHT_NAME)
          support.registry.delete(SEARCH_ACTIVE_HIGHLIGHT_NAME)
        }
      } catch (_error) {
        // Clearing is best effort.
      }
      try {
        const documentRef = pane?.ownerDocument
          ?? (typeof document === 'undefined' ? undefined : document)
        if (documentRef === undefined) return
        const roots = pane !== null && pane !== undefined ? [pane] : [documentRef]
        for (const root of roots) {
          if (typeof root.querySelectorAll !== 'function') continue
          for (const element of root.querySelectorAll(`.${SEARCH_HIT_CLASS}, .${SEARCH_ACTIVE_HIT_CLASS}`)) {
            if (typeof element.classList?.remove === 'function') {
              element.classList.remove(SEARCH_HIT_CLASS, SEARCH_ACTIVE_HIT_CLASS)
            }
          }
        }
      } catch (_error) {
        // Clearing is best effort.
      }
    }

    /**
     * Highlight the query on every hit page, with the current occurrence stronger.
     *
     * The active occurrence is chosen by its per-page ordinal: count the hits
     * before `active` that share the page. That ordinal indexes the client-side
     * match list for that page. When the client has fewer matches than the Host
     * claimed (extraction and the text layer can disagree), every match is still
     * highlighted and the first one becomes active.
     * @param pane - preview body.
     * @param needle - literal query.
     * @param hits - ordered Host hits (`{ pdf }` is the only field used here).
     * @param active - index into `hits`.
     */
    function applySearchHighlights(pane, needle, hits, active) {
      if (pane === null || pane === undefined || !Array.isArray(hits) || hits.length === 0) {
        clearSearchHighlights(pane)
        return
      }
      const queryText = String(needle ?? '').trim()
      if (queryText === '') {
        clearSearchHighlights(pane)
        return
      }
      const documentRef = pane.ownerDocument
      ensureSearchHighlightStyle(documentRef)
      clearSearchHighlights(pane)

      const elements = new Map()
      for (const entry of pageElements(pane)) elements.set(entry.number, entry.element)
      const pageNumbers = []
      const seenPages = new Set()
      for (const hit of hits) {
        const page = hit?.pdf
        if (!positiveInteger(page) || seenPages.has(page)) continue
        seenPages.add(page)
        pageNumbers.push(page)
      }

      const safeActive = Number.isInteger(active) && active >= 0 && active < hits.length ? active : 0
      const activePage = positiveInteger(hits[safeActive]?.pdf) ? hits[safeActive].pdf : undefined
      let activeOrdinal = 0
      if (activePage !== undefined) {
        for (let at = 0; at < safeActive; at += 1) {
          if (hits[at]?.pdf === activePage) activeOrdinal += 1
        }
      }

      const pageMatches = []
      for (const page of pageNumbers) {
        const element = elements.get(page)
        if (element === undefined) continue
        const nodes = []
        for (const container of element.querySelectorAll(`[${TEXT_LAYER_ATTR}]`)) {
          for (const node of collectTextNodes(container)) nodes.push(node)
        }
        const matched = matchTextNodes(nodes, queryText)
        if (matched !== undefined) pageMatches.push({ page, ...matched })
      }

      const support = searchHighlightSupport()
      if (support !== undefined) {
        try {
          const allRanges = []
          let activeRange
          for (const page of pageMatches) {
            const ranges = []
            for (const match of page.matches) {
              const range = createTextRange(documentRef, page.nodes, page.starts, match)
              if (range !== undefined) {
                ranges.push(range)
                allRanges.push(range)
              }
            }
            if (page.page === activePage && ranges.length > 0) {
              activeRange = activeOrdinal < ranges.length ? ranges[activeOrdinal] : ranges[0]
            }
          }
          if (allRanges.length > 0) {
            support.registry.set(SEARCH_HIGHLIGHT_NAME, new support.Highlight(...allRanges))
          } else {
            support.registry.delete(SEARCH_HIGHLIGHT_NAME)
          }
          if (activeRange !== undefined) {
            support.registry.set(SEARCH_ACTIVE_HIGHLIGHT_NAME, new support.Highlight(activeRange))
          } else {
            support.registry.delete(SEARCH_ACTIVE_HIGHLIGHT_NAME)
          }
          return
        } catch (_error) {
          try {
            support.registry.delete(SEARCH_HIGHLIGHT_NAME)
            support.registry.delete(SEARCH_ACTIVE_HIGHLIGHT_NAME)
          } catch (_ignored) {
            // The span fallback below is still available.
          }
        }
      }

      // Fallback for older Chromium: tint the parent spans overlapping a match.
      for (const page of pageMatches) {
        const activeIndex = page.page === activePage
          ? (activeOrdinal < page.matches.length ? activeOrdinal : 0)
          : -1
        for (let index = 0; index < page.matches.length; index += 1) {
          const match = page.matches[index]
          for (let at = 0; at < page.nodes.length; at += 1) {
            const node = page.nodes[at]
            const start = page.starts[at]
            const length = typeof node.nodeValue === 'string' ? node.nodeValue.length : 0
            if (start + length <= match.start || start >= match.end) continue
            const parent = node.parentElement
            if (parent === null || parent === undefined) continue
            if (typeof parent.classList?.add !== 'function') continue
            try {
              parent.classList.add(SEARCH_HIT_CLASS)
              if (index === activeIndex) parent.classList.add(SEARCH_ACTIVE_HIT_CLASS)
            } catch (_error) {
              // The fallback is best effort.
            }
          }
        }
      }
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
     * Find the zoom wrapper that owns the preview scrollport.
     *
     * The PDF renderer nests the frame inside the preview body, so the frame is
     * usually the scrollport's closest ancestor. A pane descendant is also
     * checked so a renderer reshuffle degrades to "no zoom restore" instead of
     * failing the page restore.
     * @param pane - preview body.
     * @param scrollport - inner scrolling element, when one exists.
     * @returns the zoom frame, or `undefined` for a renderer without zoom.
     */
    function resolveZoomFrame(pane, scrollport) {
      if (scrollport !== null && scrollport !== undefined && typeof scrollport.closest === 'function') {
        const nearest = scrollport.closest(`[${ZOOM_FRAME_ATTR}]`)
        if (isElement(nearest)) return nearest
      }
      if (pane !== null && pane !== undefined && typeof pane.querySelector === 'function') {
        const nested = pane.querySelector(`[${ZOOM_FRAME_ATTR}]`)
        if (isElement(nested)) return nested
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
     * Ask the official preview to change zoom through its own gesture path.
     *
     * The preview implements zoom as a native `wheel` listener on the scrollport:
     * it only reacts to `ctrlKey`, multiplies the current scale by
     * `exp(-deltaY * 0.01)`, clamps `deltaY` to ±40, and commits the fixed
     * preference 120 ms after the last event. Dispatching that synthetic event
     * is therefore the only supported way for a plugin to set an arbitrary
     * scale (0.25..4) without writing React state it does not own.
     * @param scrollport - the preview's inner scrolling element.
     * @param deltaY - wheel delta; negative zooms in.
     * @returns whether an event was dispatched.
     */
    function dispatchZoomWheel(scrollport, deltaY) {
      if (scrollport === null || scrollport === undefined || typeof scrollport.dispatchEvent !== 'function') {
        return false
      }
      const view = scrollport.ownerDocument?.defaultView
      const Wheel = view?.WheelEvent ?? (typeof WheelEvent === 'function' ? WheelEvent : undefined)
      if (typeof Wheel !== 'function') return false
      let event
      try {
        event = new Wheel('wheel', {
          ctrlKey: true,
          deltaY,
          deltaMode: 0,
          clientX: 0,
          clientY: 0,
          bubbles: true,
          cancelable: true,
        })
      } catch (_error) {
        return false
      }
      try {
        scrollport.dispatchEvent(event)
      } catch (_error) {
        return false
      }
      return true
    }

    /**
     * Clamp one zoom ratio into the range the preview and the Host agree on.
     * @param value - number or CSS custom-property string.
     * @returns a 3-decimal scale in 0.25..4, or `undefined` when unreadable.
     */
    function clampZoomScale(value) {
      const numeric = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
      if (!Number.isFinite(numeric)) return undefined
      return Math.round(Math.min(VIEW_ZOOM_MAX, Math.max(VIEW_ZOOM_MIN, numeric)) * 1000) / 1000
    }

    /**
     * Normalize one `GET /dsh-pdf-reader/view` payload.
     *
     * A missing row, a 404, and a malformed row all mean "nothing to restore";
     * the Host owns validation, so the client only keeps values it can act on.
     * @param body - parsed response body.
     * @returns `{ pdfPage, zoomMode, zoomScale }`, or `undefined`.
     */
    function normalizeView(body) {
      if (body === null || typeof body !== 'object' || body.ok !== true) return undefined
      const view = body.view
      if (view === null || typeof view !== 'object') return undefined
      if (!positiveInteger(view.pdfPage)) return undefined
      return {
        pdfPage: view.pdfPage,
        zoomMode: view.zoomMode === 'fixed' ? 'fixed' : 'fit-width',
        zoomScale: clampZoomScale(view.zoomScale) ?? 1,
      }
    }

    /** @returns the zoom mode the preview frame currently reports. */
    function frameZoomMode(frame) {
      if (frame === null || frame === undefined || typeof frame.getAttribute !== 'function') return 'fit-width'
      return frame.getAttribute(ZOOM_MODE_ATTR) === 'fixed' ? 'fixed' : 'fit-width'
    }

    /**
     * Read the effective zoom the preview frame currently shows.
     *
     * The renderer writes the resolved scale to the frame's inline
     * `--document-zoom` (fit-width included), so the inline value is read first
     * and the computed value only serves a frame whose style was not inlined.
     * @param frame - zoom frame, when one exists.
     * @returns a clamped, 3-decimal scale.
     */
    function frameZoomScale(frame) {
      if (frame === null || frame === undefined || typeof frame.getAttribute !== 'function') return 1
      let raw
      try {
        raw = typeof frame.style?.getPropertyValue === 'function'
          ? frame.style.getPropertyValue(ZOOM_VAR)
          : undefined
        if (raw === undefined || raw === null || String(raw).trim() === '') {
          const view = frame.ownerDocument?.defaultView
          if (view !== null && view !== undefined && typeof view.getComputedStyle === 'function') {
            raw = view.getComputedStyle(frame).getPropertyValue(ZOOM_VAR)
          }
        }
      } catch (_error) {
        raw = undefined
      }
      return clampZoomScale(raw) ?? 1
    }

    /** @returns `{ zoomMode, zoomScale }` as the frame currently shows them. */
    function readFrameZoom(frame) {
      return { zoomMode: frameZoomMode(frame), zoomScale: frameZoomScale(frame) }
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
     * Which mounted contribution answers the next Cmd/Ctrl+F.
     * Pointing at a preview claims it, exactly like dsh-pdf-search's Ctrl+F.
     */
    let activeOwner

    const CONTROL_STYLE = {
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '3px',
      height: '24px',
      fontSize: '10px',
      lineHeight: '22px',
      color: 'inherit',
      userSelect: 'none',
      whiteSpace: 'nowrap',
      // Visually separate this group from the host's own header controls: a
      // divider plus a faint pill, so the plugin's five controls read as one
      // cluster instead of blending into the built-in toolbar.
      marginLeft: '10px',
      paddingLeft: '10px',
      paddingRight: '5px',
      borderLeft: '1px solid rgba(128,128,128,0.45)',
      borderRadius: '7px',
      background: 'rgba(128,128,128,0.10)',
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

    const SEARCH_COUNT_STYLE = {
      minWidth: '42px',
      flex: '0 0 auto',
      textAlign: 'center',
      fontVariantNumeric: 'tabular-nums',
      opacity: 0.8,
      fontSize: '11px',
    }

    const SEARCH_HINT_STYLE = { ...MUTED_STYLE, fontSize: '10px' }

    /**
     * The Client locale service, attached by `apply`. Absent in headless tests,
     * where the language then falls back to the browser's own preference.
     */
    let localeService

    /** @returns the active UI language id, e.g. `zh` or `en`. */
    function activeLanguage() {
      let id
      try {
        id = localeService?.getSnapshot?.().active
      } catch (_error) {
        id = undefined
      }
      if (typeof id !== 'string' || id === '') {
        try {
          id = typeof navigator === 'undefined' ? 'en' : navigator.language
        } catch (_error) {
          id = 'en'
        }
      }
      return /^zh/iu.test(String(id)) ? 'zh' : 'en'
    }

    /** Delay before a hover explanation appears, in milliseconds. */
    const TIP_DELAY_MS = 200

    /**
     * Hover explanations for the preview toolbar controls, in both UI languages.
     * Each entry is `[title, one-line explanation]`; the follow control appends
     * its live reporting state through `followTipBody`.
     */
    const TOOLTIPS = {
      prev: {
        zh: ['上一页', '翻到上一页'],
        en: ['Previous page', 'Go to the previous page'],
      },
      next: {
        zh: ['下一页', '翻到下一页'],
        en: ['Next page', 'Go to the next page'],
      },
      page: {
        zh: ['页码', '输入页码后回车跳转；默认按印刷页码，前缀 p 表示 PDF 页码'],
        en: ['Page number', 'Type a page and press Enter; printed page by default, prefix p for a PDF page'],
      },
      search: {
        zh: ['搜索', '搜索这个 PDF 的文字层（Cmd/Ctrl+F）'],
        en: ['Search', "Search this PDF's text layer (Cmd/Ctrl+F)"],
      },
      follow: {
        zh: ['AI 上下文', '把当前阅读页报告给模型'],
        en: ['AI context', 'Report the page you are reading to the model'],
      },
      closeSearch: {
        zh: ['关闭搜索', '收起搜索面板（Esc）'],
        en: ['Close search', 'Close the search panel (Esc)'],
      },
      prevHit: {
        zh: ['上一个匹配', '跳到上一个命中（Shift+Enter）'],
        en: ['Previous match', 'Jump to the previous occurrence (Shift+Enter)'],
      },
      nextHit: {
        zh: ['下一个匹配', '跳到下一个命中（Enter）'],
        en: ['Next match', 'Jump to the next occurrence (Enter)'],
      },
    }

    /** Find-bar copy, in both UI languages. */
    const SEARCH_COPY = {
      label: { zh: '搜索这个 PDF', en: 'Search this PDF' },
      hint: {
        zh: 'Enter 下一个 · Shift+Enter 上一个 · Esc 关闭',
        en: 'Enter next · Shift+Enter previous · Esc close',
      },
      prev: { zh: '上一个匹配', en: 'Previous match' },
      next: { zh: '下一个匹配', en: 'Next match' },
    }

    /** @returns one find-bar string in the active UI language. */
    function searchCopy(key) {
      const entry = SEARCH_COPY[key]
      if (entry === undefined) return ''
      return entry[activeLanguage()] ?? entry.en
    }

    /** @returns the localized explanation body for the follow control. */
    function followTipBody(lang, state) {
      const display = state?.display
      const reportState = state?.reportState
      const follow = state?.follow
      if (lang === 'zh') {
        if (!follow) return '关闭：不向模型报告当前页'
        if (reportState === 'sending') return `开启：正在报告第 ${display} 页…`
        if (reportState === 'ok') return `开启：模型已知当前第 ${display} 页`
        if (reportState === 'error') return '开启：Host 路由不可用，报告失败'
        return `开启：将把当前页（第 ${display} 页）告诉模型`
      }
      if (!follow) return 'Off — the host is not told which page you are on'
      if (reportState === 'sending') return `On — reporting page ${display}…`
      if (reportState === 'ok') return `On — the host knows page ${display}`
      if (reportState === 'error') return 'On — the host route is unavailable'
      return `On — the current page (${display}) will be reported`
    }

    /**
     * @param key - a `TOOLTIPS` key.
     * @param state - the component's current follow/report/page facts.
     * @returns `{ title, body }` in the active UI language, or undefined.
     */
    function tipContent(key, state) {
      const entry = TOOLTIPS[key]
      if (entry === undefined) return undefined
      const lang = activeLanguage()
      const text = entry[lang] ?? entry.en
      return {
        title: text[0],
        body: key === 'follow' ? followTipBody(lang, state) : text[1],
      }
    }

    const TIP_STYLE = {
      position: 'fixed',
      zIndex: 2147483001,
      maxWidth: '260px',
      padding: '6px 8px',
      border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.45))',
      borderRadius: '6px',
      background: 'var(--dsw-alias-bg-overlay, Canvas)',
      color: 'var(--dsw-alias-label-primary, CanvasText)',
      boxShadow: '0 6px 20px rgba(0,0,0,.22)',
      font: '11px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
      pointerEvents: 'none',
      whiteSpace: 'normal',
      textAlign: 'left',
      colorScheme: 'light dark',
      boxSizing: 'border-box',
    }

    const TIP_TITLE_STYLE = { fontWeight: 600, fontSize: '11px' }
    const TIP_BODY_STYLE = {
      marginTop: '2px',
      color: 'var(--dsw-alias-label-secondary, CanvasText)',
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
     * The header contribution for one PDF preview.
     * @param props - Session-scope standard props plus the preview's `absolutePath`.
     */
    function PdfReaderAction(props) {
      const absolutePath = typeof props?.absolutePath === 'string' ? props.absolutePath : undefined
      const isPdf = isPdfPath(absolutePath)
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined

      const hostRef = useRef(null)
      const searchButtonRef = useRef(null)
      const searchInputRef = useRef(null)
      const ownerRef = useRef(null)
      if (ownerRef.current === null) ownerRef.current = Symbol('dsh-pdf-reader')
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
      /** Latest sampled page, readable from the debounced view save. */
      const pageRef = useRef(1)
      /** Installed by the view effect; `null` when this preview keeps no view. */
      const requestViewSaveRef = useRef(null)

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
      const [active, setActive] = useState(0)
      const [searching, setSearching] = useState(false)
      const [searchError, setSearchError] = useState(null)
      const [tip, setTip] = useState(null)
      const follow = useFollow()
      const tipTimerRef = useRef(null)
      const tipKeyRef = useRef(null)

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

      /** Hide the hover explanation and cancel a pending show. */
      const hideTip = () => {
        if (tipTimerRef.current !== null) {
          globalThis.clearTimeout(tipTimerRef.current)
          tipTimerRef.current = null
        }
        if (tipKeyRef.current !== null) {
          tipKeyRef.current = null
          setTip(null)
        }
      }

      /**
       * Arm the hover explanation for the closest control carrying `data-tip`.
       * The explanation waits `TIP_DELAY_MS` so passing over the toolbar stays quiet.
       */
      const armTip = (event) => {
        const target = event?.target
        const element = target !== null && target !== undefined && typeof target.closest === 'function'
          ? target.closest('[data-tip]')
          : null
        if (element === null || element === undefined) return
        const key = element.getAttribute('data-tip')
        if (typeof key !== 'string' || key === '' || tipKeyRef.current === key) return
        if (tipTimerRef.current !== null) globalThis.clearTimeout(tipTimerRef.current)
        tipKeyRef.current = key
        tipTimerRef.current = globalThis.setTimeout(() => {
          tipTimerRef.current = null
          if (!element.isConnected) return
          const rect = element.getBoundingClientRect()
          setTip({ key, left: rect.left + rect.width / 2, top: rect.bottom })
        }, TIP_DELAY_MS)
      }

      /** Hide unless the pointer or focus moved to another control of this group. */
      const leaveTip = (event) => {
        const related = event?.relatedTarget
        const host = hostRef.current
        if (host !== null && related !== null && related !== undefined && host.contains(related)) return
        hideTip()
      }

      /** Focus the search input; keep the query highlighted for quick replacement. */
      const openSearch = () => {
        const input = searchInputRef.current
        if (input === null) {
          // The panel is not mounted yet, so this is a fresh open: start clean
          // and let the search effect re-query the kept query.
          setHits(null)
          setActive(0)
          setSearching(false)
          setSearchError(null)
        }
        setOpen(true)
        if (input !== null) {
          input.focus()
          input.select()
        }
      }

      /** Close the panel and give focus back to the header button. */
      const closeSearch = () => {
        setOpen(false)
        searchButtonRef.current?.focus()
      }

      /**
       * Highlighted navigation helpers.
       *
       * Search is deliberately the most basic kind: one query, a list of Host
       * hits, and previous/next stepping that wraps at both ends. The counter
       * updates immediately; the in-page highlight effect waits for the page's
       * lazily rendered text layer.
       */
      const navigateHits = (list, index) => {
        if (!Array.isArray(list) || list.length === 0) return false
        const count = list.length
        const requested = Number.isFinite(index) ? Math.trunc(index) : 0
        const next = ((requested % count) + count) % count
        const hit = list[next]
        if (hit === undefined) return false
        jumpTo(hit.pdf)
        setActive(next)
        return true
      }

      /** Move to an absolute hit index (the caller adds or subtracts one). */
      const navigate = (index) => navigateHits(hits, index)

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
        setActive(0)
        setSearching(false)
        setSearchError(null)
        lastReportedKeyRef.current = undefined
        pageRef.current = 1
        reportAbortRef.current?.abort()
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

      // Restore the last page/zoom for this book, then persist both best-effort.
      //
      // The official preview keeps neither across tabs, so this owns one restore
      // per absolutePath: fetch the saved view in parallel with rendering, wait
      // (up to ~8 s) for the preview structure and the target page, drive the
      // renderer's own Ctrl+wheel path for a fixed zoom, and only then allow
      // saving. The gate matters: saving before the restore lands would replace
      // the saved page with page 1 every time a book is opened.
      useEffect(() => {
        if (!isPdf || absolutePath === undefined) return undefined
        const host = hostRef.current
        if (host === null) return undefined
        const pdfPath = absolutePath

        let disposed = false
        let finished = false
        let pane
        let scrollport
        let frame
        let attributeObserver
        let structureObserver
        let retryTimer
        let retryCount = 0
        let reapplyTimer
        let zoomTimer
        let zoomEvents = 0
        let restoreTarget
        let lastAttemptKey = ''
        const restoreController = new AbortController()
        const saveController = new AbortController()

        const saveDebouncer = createDebouncer(
          VIEW_SAVE_DELAY_MS,
          (fn, ms) => globalThis.setTimeout(fn, ms),
          (id) => globalThis.clearTimeout(id),
        )
        const structureDebouncer = createDebouncer(
          250,
          (fn, ms) => globalThis.setTimeout(fn, ms),
          (id) => globalThis.clearTimeout(id),
        )

        /**
         * Persist the current page and zoom. The four client fields are the whole
         * contract; the Host stamps `updatedAt`. Identical consecutive payloads
         * are suppressed, and a failed write is retried by the next trigger.
         */
        const saveNow = () => {
          if (disposed || !finished) return
          if (typeof fetch !== 'function') return
          // A debounced save is also a cheap reconnect point: if the preview
          // replaced its structure, resolve it again before reading the frame.
          refresh()
          const zoom = readFrameZoom(frame)
          const payload = {
            path: pdfPath,
            pdfPage: positiveInteger(pageRef.current) ? pageRef.current : 1,
            zoomMode: zoom.zoomMode,
            zoomScale: zoom.zoomScale,
          }
          const key = JSON.stringify(payload)
          if (key === lastAttemptKey) return
          lastAttemptKey = key
          let request
          try {
            request = fetch(VIEW_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify(payload),
              signal: saveController.signal,
              keepalive: true,
            })
          } catch (_error) {
            lastAttemptKey = ''
            return
          }
          Promise.resolve(request)
            .then((response) => {
              if (disposed) return
              if (response !== null && response !== undefined && response.ok === true) return
              if (lastAttemptKey === key) lastAttemptKey = ''
            })
            .catch(() => {
              if (disposed) return
              if (lastAttemptKey === key) lastAttemptKey = ''
            })
        }

        const requestSave = () => {
          if (disposed) return
          saveDebouncer.schedule(saveNow)
        }
        requestViewSaveRef.current = requestSave

        /** Allow saving once, including when the restore failed or timed out. */
        const finish = () => {
          if (disposed || finished) return
          finished = true
          requestSave()
        }

        const detach = () => {
          attributeObserver?.disconnect()
          attributeObserver = undefined
          structureObserver?.disconnect()
          structureObserver = undefined
        }

        const observeStructure = () => {
          structureObserver?.disconnect()
          structureObserver = undefined
          if (typeof MutationObserver !== 'function') return
          const root = pane?.parentElement ?? host.parentElement ?? pane ?? host
          if (root === null || root === undefined) return
          structureObserver = new MutationObserver(() => {
            if (disposed) return
            structureDebouncer.schedule(syncStructure)
          })
          structureObserver.observe(root, { childList: true, subtree: true })
        }

        const observeFrame = (target) => {
          attributeObserver?.disconnect()
          attributeObserver = undefined
          if (target === null || target === undefined) return
          if (typeof MutationObserver !== 'function') return
          attributeObserver = new MutationObserver(() => {
            if (disposed) return
            requestSave()
          })
          attributeObserver.observe(target, {
            attributes: true,
            attributeFilter: [ZOOM_MODE_ATTR, 'style'],
            subtree: false,
          })
        }

        const bind = (nextPane, nextScrollport, nextFrame) => {
          attributeObserver?.disconnect()
          attributeObserver = undefined
          structureObserver?.disconnect()
          structureObserver = undefined
          pane = nextPane
          scrollport = nextScrollport
          frame = nextFrame
          observeFrame(frame)
          observeStructure()
        }

        const syncStructure = () => {
          if (disposed) return
          const nextPane = resolvePane(host)
          if (nextPane === undefined) return
          const nextScrollport = resolveScrollport(nextPane)
          const nextFrame = resolveZoomFrame(nextPane, nextScrollport)
          if (nextPane !== pane || nextScrollport !== scrollport || nextFrame !== frame) {
            bind(nextPane, nextScrollport, nextFrame)
          }
        }

        /** Re-resolve the preview structure; true when a body exists. */
        const refresh = () => {
          const nextPane = resolvePane(host)
          if (nextPane === undefined) return false
          const nextScrollport = resolveScrollport(nextPane)
          const nextFrame = resolveZoomFrame(nextPane, nextScrollport)
          if (nextPane !== pane || nextScrollport !== scrollport || nextFrame !== frame) {
            bind(nextPane, nextScrollport, nextFrame)
          }
          return true
        }

        const retryRestore = () => {
          if (disposed || finished || retryTimer !== undefined) return
          if (retryCount >= VIEW_RETRY_LIMIT) {
            finish()
            return
          }
          retryCount += 1
          retryTimer = globalThis.setTimeout(() => {
            retryTimer = undefined
            if (!disposed) stepRestore()
          }, VIEW_RETRY_MS)
        }

        /**
         * Scroll the saved page into view, then re-apply once. The second scroll
         * absorbs pages that were 3:4 placeholders and grew when lazily rendered.
         *
         * With `finishGate: false` the page jump happens immediately but the save
         * gate stays closed — the caller restores zoom afterwards and then
         * calls `finish()`. That keeps the viewer from showing page 1 while a
         * fixed zoom is being replayed gesture by gesture.
         * @param options - `{ finishGate }`, default true.
         * @returns whether the scroll was applied.
         */
        const placePage = ({ finishGate = true } = {}) => {
          if (disposed || restoreTarget === undefined) return false
          const target = restoreTarget.pdfPage
          if (!refresh() || !scrollPageIntoView(pane, scrollport, target)) {
            retryRestore()
            return false
          }
          // The save debounce reads this ref, and the restore runs from a timer
          // (not a React event), so publish the page before state can render.
          pageRef.current = target
          setPage(target)
          setSampled(true)
          if (finishGate) finish()
          if (reapplyTimer !== undefined) globalThis.clearTimeout(reapplyTimer)
          reapplyTimer = globalThis.setTimeout(() => {
            reapplyTimer = undefined
            if (disposed || !refresh()) return
            scrollPageIntoView(pane, scrollport, target)
          }, VIEW_REAPPLY_MS)
          return true
        }

        /**
         * Let the renderer's 120 ms zoom settlement commit, then scroll again so
         * the saved page is aligned after the zoom reflowed every page.
         */
        const settleZoom = () => {
          if (zoomTimer !== undefined) globalThis.clearTimeout(zoomTimer)
          zoomTimer = globalThis.setTimeout(() => {
            zoomTimer = undefined
            if (!disposed) placePage()
          }, VIEW_ZOOM_SETTLE_MS)
        }

        /**
         * Drive Ctrl+wheel events until the frame scale is within 2% of the saved
         * fixed scale. Each event can change the ratio by at most ~1.49x, so a
         * large jump needs a few events; the event budget bounds a missing or
         * non-responsive handler.
         */
        const stepZoom = () => {
          if (disposed || restoreTarget === undefined) return
          const target = restoreTarget.zoomScale
          if (!refresh() || frame === undefined || scrollport === undefined) {
            finish()
            return
          }
          const current = frameZoomScale(frame)
          if (Math.abs(current / target - 1) <= VIEW_ZOOM_TOLERANCE) {
            if (frameZoomMode(frame) !== 'fixed') {
              // Same scale, fit-width mode: a zero-delta gesture only asks the
              // renderer to commit `{kind:'fixed'}` at the current scale.
              if (!dispatchZoomWheel(scrollport, 0)) {
                finish()
                return
              }
            }
            // The renderer commits its fixed preference 120 ms after the last
            // gesture and only then re-renders pages at the new scale.
            settleZoom()
            return
          }
          if (zoomEvents >= VIEW_ZOOM_EVENT_LIMIT) {
            settleZoom()
            return
          }
          const deltaY = Math.max(-40, Math.min(40, -100 * Math.log(target / current)))
          if (!Number.isFinite(deltaY) || Math.abs(deltaY) < 0.05) {
            settleZoom()
            return
          }
          zoomEvents += 1
          if (!dispatchZoomWheel(scrollport, deltaY)) {
            settleZoom()
            return
          }
          zoomTimer = globalThis.setTimeout(() => {
            zoomTimer = undefined
            if (!disposed) stepZoom()
          }, VIEW_ZOOM_STEP_MS)
        }

        const stepRestore = () => {
          if (disposed || finished || restoreTarget === undefined) return
          const target = restoreTarget
          if (!refresh()) {
            retryRestore()
            return
          }
          const page = pane.querySelector(`[${PAGE_ATTR}="${target.pdfPage}"]`)
          if (!isElement(page)) {
            retryRestore()
            return
          }
          // Jump first so the cover never flashes while a fixed zoom is replayed.
          if (!placePage({ finishGate: false })) return
          if (target.zoomMode === 'fixed' && frame !== undefined && scrollport !== undefined) {
            if (Math.abs(frameZoomScale(frame) / target.zoomScale - 1) > VIEW_ZOOM_TOLERANCE
              || frameZoomMode(frame) !== 'fixed') {
              stepZoom()
              return
            }
          }
          finish()
        }

        const loadSavedView = async () => {
          const timer = globalThis.setTimeout(() => {
            restoreController.abort()
          }, VIEW_TIMEOUT_MS)
          try {
            const { body } = await fetchJson(
              `${VIEW_ROUTE}?path=${encodeURIComponent(pdfPath)}`,
              { headers: { accept: 'application/json' }, signal: restoreController.signal },
            )
            if (disposed) return
            const saved = normalizeView(body)
            if (saved === undefined) {
              finish()
              return
            }
            restoreTarget = saved
            stepRestore()
          } catch (_error) {
            if (disposed) return
            // A missing route, a network failure, or a timeout must not block
            // saving forever: the restore is best effort.
            finish()
          } finally {
            globalThis.clearTimeout(timer)
          }
        }

        // Observe the current structure while the GET is in flight, so a zoom the
        // reader performs before the response still gets saved once the gate opens.
        refresh()
        void loadSavedView()

        return () => {
          disposed = true
          restoreController.abort()
          saveController.abort()
          saveDebouncer.cancel()
          structureDebouncer.cancel()
          if (retryTimer !== undefined) globalThis.clearTimeout(retryTimer)
          if (reapplyTimer !== undefined) globalThis.clearTimeout(reapplyTimer)
          if (zoomTimer !== undefined) globalThis.clearTimeout(zoomTimer)
          detach()
          if (requestViewSaveRef.current === requestSave) requestViewSaveRef.current = null
        }
      }, [isPdf, absolutePath])

      // Save the sampled page through the same 500 ms gate as zoom changes.
      useEffect(() => {
        pageRef.current = page
        if (sampled) requestViewSaveRef.current?.()
      }, [page, sampled])

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
          if (reportAbortRef.current !== null) {
            // The Host may already have received the aborted page. Forget the
            // acknowledged key so a detour back to the old page re-reports it.
            reportAbortRef.current.abort()
            reportAbortRef.current = null
            lastReportedKeyRef.current = undefined
          }
        }
      }, [isPdf, absolutePath, sampled, page, printed, sessionId, follow])

      // Search: type, wait 220 ms, query the Host route, cancel the stale query.
      // A new query starts from a clean slate: no stale highlights or counter.
      useEffect(() => {
        if (!open || !isPdf || absolutePath === undefined) return undefined
        const needle = query.trim()
        if (needle === '') {
          setHits(null)
          setActive(0)
          setSearchError(null)
          setSearching(false)
          return undefined
        }
        setSearching(true)
        setSearchError(null)
        setHits(null)
        setActive(0)
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
                setActive(0)
                setSearchError(describeSearchFailure(body, status))
                return
              }
              const list = Array.isArray(body.hits)
                ? body.hits.map(normalizeHit).filter((hit) => hit !== undefined)
                : []
              setHits(list)
              setSearchError(null)
              if (list.length > 0) {
                // Basic find behavior: the first occurrence becomes current and
                // the preview immediately jumps to its page.
                navigateHits(list, 0)
              } else {
                setActive(0)
              }
            })
            .catch((error) => {
              if (disposed || (isAbortError(error) && !timedOut)) return
              setHits([])
              setActive(0)
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

      // In-page highlights: locate each hit page's text layer, map the query to
      // Ranges, and rebuild when pdf.js renders or re-renders a page (zoom).
      //
      // The text layer arrives lazily, so the first attempt retries for about
      // three seconds. Once the active page has a text layer, the timers stop
      // and the MutationObserver keeps the highlights in sync. Every path is
      // guarded: highlighting must never break reading or search itself.
      useEffect(() => {
        if (!open || !isPdf || absolutePath === undefined) return undefined
        const needle = query.trim()
        if (searching || searchError !== null || hits === null || hits.length === 0 || needle === '') {
          clearSearchHighlights(resolvePane(hostRef.current))
          return undefined
        }
        const host = hostRef.current
        if (host === null) return undefined
        const list = hits
        const current = Number.isInteger(active) ? active : 0
        const activePage = list[Math.min(Math.max(current, 0), list.length - 1)]?.pdf

        let disposed = false
        let observer
        let observedPane
        let retryTimer
        let retryCount = 0
        let rebuildTimer

        const activeTextReady = () => {
          if (activePage === undefined) return true
          const pane = resolvePane(host)
          if (pane === undefined) return false
          const page = pane.querySelector(`[${PAGE_ATTR}="${activePage}"]`)
          if (page === null || page === undefined) return false
          return page.querySelector(`[${TEXT_LAYER_ATTR}]`) !== null
        }

        const observe = (pane) => {
          if (pane === observedPane) return
          observer?.disconnect()
          observer = undefined
          observedPane = pane
          if (typeof MutationObserver !== 'function') return
          try {
            observer = new MutationObserver(() => {
              scheduleRebuild()
            })
            observer.observe(pane, { childList: true, subtree: true, characterData: true })
          } catch (_error) {
            observer = undefined
          }
        }

        const rebuild = () => {
          if (disposed) return
          const pane = resolvePane(host)
          if (pane === undefined) return
          observe(pane)
          applySearchHighlights(pane, needle, list, current)
        }

        const scheduleRebuild = () => {
          if (disposed || rebuildTimer !== undefined) return
          rebuildTimer = globalThis.setTimeout(() => {
            rebuildTimer = undefined
            rebuild()
          }, SEARCH_HIGHLIGHT_REBUILD_MS)
        }

        const retry = () => {
          if (disposed || retryTimer !== undefined || retryCount >= SEARCH_HIGHLIGHT_RETRY_LIMIT) return
          retryCount += 1
          retryTimer = globalThis.setTimeout(() => {
            retryTimer = undefined
            if (disposed) return
            rebuild()
            if (!activeTextReady()) retry()
          }, SEARCH_HIGHLIGHT_RETRY_MS)
        }

        rebuild()
        if (!activeTextReady()) retry()

        return () => {
          disposed = true
          observer?.disconnect()
          observer = undefined
          if (retryTimer !== undefined) globalThis.clearTimeout(retryTimer)
          if (rebuildTimer !== undefined) globalThis.clearTimeout(rebuildTimer)
          clearSearchHighlights(resolvePane(host))
        }
      }, [open, isPdf, absolutePath, query, hits, active, searching, searchError])

      // Cmd/Ctrl+F (with or without Shift) opens our find bar. The first panel
      // claims the shortcut; pointing at another preview claims it for that one.
      useEffect(() => {
        if (!isPdf) return undefined
        const owner = ownerRef.current
        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.repeat || event.isComposing) return
          if (!(event.metaKey || event.ctrlKey) || event.altKey) return
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

      // Focus and select the find input once the panel has actually mounted.
      // Doing this in an effect (instead of the click handler's timer) also
      // covers the very first open, when the input ref does not exist yet.
      useEffect(() => {
        if (!open) return undefined
        const input = searchInputRef.current
        if (input === null) return undefined
        try {
          input.focus()
          input.select()
        } catch (_error) {
          // Focus is best effort (for example while the tab is hidden).
        }
        return undefined
      }, [open])

      // Timers that outlive a render and must not outlive the component.
      useEffect(() => () => {
        if (flashTimerRef.current !== null) globalThis.clearTimeout(flashTimerRef.current)
        if (tipTimerRef.current !== null) globalThis.clearTimeout(tipTimerRef.current)
      }, [])

      if (!isPdf) return null

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
          'aria-label': 'Previous page',
          'data-tip': 'prev',
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
          'data-tip': 'page',
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
          'aria-label': 'Next page',
          'data-tip': 'next',
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
          'aria-label': 'Search this PDF',
          'aria-expanded': open,
          'data-tip': 'search',
          'data-dsh-pdf-reader': 'search',
          onClick: () => {
            if (open) closeSearch()
            else openSearch()
          },
          style: BUTTON_STYLE,
        }, SEARCH_ICON),
        h('button', {
          key: 'follow',
          type: 'button',
          'aria-label': 'AI context reporting',
          'aria-pressed': follow,
          'data-tip': 'follow',
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
        const hitCount = hits === null ? 0 : hits.length
        const shownHit = hitCount === 0 ? 0 : Math.min(Math.max(active, 0), hitCount - 1) + 1
        const noHits = hitCount === 0
        const searchDisabledStyle = noHits ? { opacity: 0.35 } : null
        panel = h('div', {
          key: 'panel',
          style: PANEL_STYLE,
          role: 'dialog',
          'aria-label': searchCopy('label'),
          'aria-busy': searching,
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
            placeholder: searchCopy('label'),
            'aria-label': searchCopy('label'),
            'data-dsh-pdf-reader': 'search-input',
            spellCheck: false,
            autoComplete: 'off',
            maxLength: 1000,
            style: PANEL_INPUT_STYLE,
            onChange: (event) => {
              setQuery(String(event.target.value))
              setHits(null)
              setActive(0)
              setSearchError(null)
            },
            onKeyDown: (event) => {
              if (event.isComposing) return
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                navigate(active + (event.shiftKey ? -1 : 1))
              }
            },
          }),
          h('button', {
            type: 'button',
            'aria-label': searchCopy('prev'),
            'data-tip': 'prevHit',
            'data-dsh-pdf-reader': 'search-prev',
            disabled: noHits,
            onClick: () => {
              navigate(active - 1)
            },
            style: { ...BUTTON_STYLE, ...searchDisabledStyle },
          }, '‹'),
          h('span', {
            'data-dsh-pdf-reader': 'search-count',
            'aria-live': 'polite',
            style: SEARCH_COUNT_STYLE,
          }, `${shownHit} / ${hitCount}`),
          h('button', {
            type: 'button',
            'aria-label': searchCopy('next'),
            'data-tip': 'nextHit',
            'data-dsh-pdf-reader': 'search-next',
            disabled: noHits,
            onClick: () => {
              navigate(active + 1)
            },
            style: { ...BUTTON_STYLE, ...searchDisabledStyle },
          }, '›'),
          h('button', {
            type: 'button',
            'aria-label': 'Close search',
            'data-tip': 'closeSearch',
            'data-dsh-pdf-reader': 'search-close',
            onClick: closeSearch,
            style: BUTTON_STYLE,
          }, '✕')),
        h('div', {
          'data-dsh-pdf-reader': 'search-hint',
          style: SEARCH_HINT_STYLE,
        }, searchCopy('hint')),
        searchError === null
          ? null
          : h('div', {
            'data-dsh-pdf-reader': 'search-error',
            role: 'status',
            style: { ...ERROR_STYLE, fontSize: '11px' },
          }, searchError))
      }

      controls.push(panel)

      let tipNode = null
      if (tip !== null) {
        const content = tipContent(tip.key, { follow, reportState, display })
        if (content !== undefined) {
          tipNode = h('div', {
            role: 'tooltip',
            'data-dsh-pdf-reader': 'tip',
            style: {
              ...TIP_STYLE,
              left: `${Math.round(tip.left)}px`,
              top: `${Math.round(tip.top + 6)}px`,
              transform: 'translateX(-50%)',
            },
          },
          h('div', { style: TIP_TITLE_STYLE }, content.title),
          content.body === '' ? null : h('div', { style: TIP_BODY_STYLE }, content.body))
        }
      }

      return h('span', {
        ref: hostRef,
        style: CONTROL_STYLE,
        'data-dsh-pdf-reader': 'controls',
        onMouseOver: armTip,
        onMouseOut: leaveTip,
        onFocus: armTip,
        onBlur: leaveTip,
      }, ...controls, tipNode)
    }

    /** Required browser services: the slot registry and the locale preference. */
    const inject = ['slots', 'locale']

    /**
     * Register the document-header contribution.
     * @param ctx - client root context carrying the slot registry.
     */
    function apply(ctx) {
      // Read-only use of the locale preference: the tooltips resolve their
      // language when shown, so no subscription is needed.
      localeService = ctx.locale
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
      PANEL_STYLE,
      SEARCH_ACTIVE_HIGHLIGHT_NAME,
      SEARCH_HIGHLIGHT_NAME,
      cachedInfo,
      clampZoomScale,
      createDebouncer,
      createRafThrottle,
      describeSearchFailure,
      displayPage,
      dispatchZoomWheel,
      fetchJson,
      foldSearchText,
      infoCache,
      isPdfPath,
      normalizeInfo,
      normalizeSnippet,
      normalizeView,
      pageElements,
      parsePageInput,
      pickPage,
      positiveInteger,
      printedPageOf,
      readFrameZoom,
      rememberInfo,
      resolvePane,
      resolveScrollport,
      resolveZoomFrame,
      scrollPageIntoView,
    }
    return module.exports
  },
})
