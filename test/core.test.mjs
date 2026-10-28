/**
 * dsh-pdf-reader core tests.
 *
 * Run with plain Node (no test framework):
 *
 *   cd dsh-pdf-reader && node test/core.test.mjs
 *
 * These tests exercise the real PDFs in the workspace and the real Node
 * rendering path.  They assert the host-facing contract, not implementation
 * details, and print the measured timings used in lib/core/README.md.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildSearchLayout,
  cleanSearchQuery,
  closePdf,
  getInfo,
  getPageText,
  normalizeSearchText,
  rankSearchHits,
  searchPdf,
} from '../lib/core/pdf.js'
import { renderPageToPng, renderPagesToPng } from '../lib/core/render.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(HERE, '..', '..')
const BOOK = join(WORKSPACE, 'Linear Algebra Done Right-Springer (2024).pdf')
const SOLUTIONS = join(WORKSPACE, 'LADR_Solutions.pdf')

// A tiny password-protected PDF (RC4 revision 2, user password "secret").
// It has a real page + encrypted content stream, so pdf.js raises
// PasswordException("No password given") when opened without a password.
// This lets the test prove encrypted files produce a clear error, without
// shipping a separate fixture file.
const ENCRYPTED_PDF_BASE64 =
  'JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNiAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1MyA+PgpzdHJlYW0Kl6J7AAU2G8C/e9ARDQO3BEzaoGvI2MBTXuvR2kwWLK81lQluqdO5VFbZ1b84v8E+XPQySIIKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9GaWx0ZXIgL1N0YW5kYXJkIC9WIDEgL1IgMiAvTyA8Y2I1ODliYTdhYmU3ZjA1NTZjZmQ0MDFmNGMyNjNmOGQ2NGE1YWFhZDljMjBjY2I2ZGU3ZTkxYTA3NTdmN2IzND4gL1UgPDNjODRlYTAzN2Y4NWJhYjVmYjc4MzcwNWQyMGM4ZjlmNmM0NDVjMjMyYzliYjkwNWU4OTBjZjlhNDdjMWU2YTY+IC9QIC0xID4+CmVuZG9iago2IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDcKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAwNjQgMDAwMDAgbiAKMDAwMDAwMDEyMSAwMDAwMCBuIAowMDAwMDAwMjQ3IDAwMDAwIG4gCjAwMDAwMDAzNTAgMDAwMDAgbiAKMDAwMDAwMDU0NSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDcgL1Jvb3QgMSAwIFIgL0VuY3J5cHQgNSAwIFIgL0lEIFs8MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY+PDAxMjM0NTY3ODlhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmPl0gPj4Kc3RhcnR4cmVmCjYxNQolJUVPRgo='

// A plain one-page PDF with no /PageLabels and no /Outlines.  Used to prove
// that metadata degrades to labels: [], printedOffset: null, outline: [].
const MINIMAL_PDF_BASE64 =
  'JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgNDAwXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAwNjQgMDAwMDAgbiAKMDAwMDAwMDEyMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjE5MgolJUVPRgo='

const timings = new Map()
let checks = 0

async function step(name, fn) {
  const start = performance.now()
  const value = await fn()
  const ms = performance.now() - start
  timings.set(name, ms)
  checks += 1
  console.log(`  ✓ ${name} (${ms.toFixed(1)} ms)`)
  return value
}

function assertPng(result, expectedWidth, expectedHeight) {
  assert.ok(Buffer.isBuffer(result.buffer), 'PNG result is a Node Buffer')
  assert.equal(result.buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature')
  assert.equal(result.buffer.toString('ascii', 12, 16), 'IHDR', 'PNG starts with IHDR')
  assert.equal(result.buffer.readUInt32BE(16), expectedWidth, 'PNG width')
  assert.equal(result.buffer.readUInt32BE(20), expectedHeight, 'PNG height')
  assert.equal(result.buffer[24], 8, 'PNG bit depth 8')
  assert.equal(result.buffer[25], 2, 'PNG color type 2 (RGB, not RGBA)')
  assert.equal(result.width, expectedWidth)
  assert.equal(result.height, expectedHeight)
}

console.log('dsh-pdf-reader core tests')
console.log(`  book: ${BOOK}`)

const tempDir = await mkdtemp(join(tmpdir(), 'dsh-pdf-reader-core-'))

try {
  // -------------------------------------------------------------------------
  // getInfo / page labels / offset / outline
  // -------------------------------------------------------------------------
  const info = await step('getInfo cold (open + labels + outline)', async () => {
    const value = await getInfo(BOOK)
    assert.equal(value.pageCount, 410)
    assert.equal(value.path, BOOK)
    assert.equal(value.labels.length, 410)
    assert.equal(value.printedOffset, 20, 'printedOffset = physical - printed')
    return value
  })

  await step('page labels map printed = pdf - 20', () => {
    assert.deepEqual(info.labels[20], { pdf: 21, printed: 1 })
    assert.deepEqual(info.labels[409], { pdf: 410, printed: 390 })
    for (const pdfPage of [21, 22, 100, 247, 293, 344, 410]) {
      assert.equal(info.labels[pdfPage - 1].printed, pdfPage - 20)
    }
    // Roman front matter keeps its label rather than a bogus negative number.
    assert.equal(info.labels[1].printed, 'i')
    assert.equal(info.labels[19].printed, 'xvii')
  })

  await step('outline resolves >= 30 entries and Chapter 1 -> 21/1', () => {
    assert.ok(info.outline.length >= 30, `outline has ${info.outline.length} entries`)
    for (const entry of info.outline) {
      assert.equal(typeof entry.title, 'string')
      assert.ok(entry.title.length > 0)
      assert.ok(Number.isInteger(entry.pdf) && entry.pdf >= 1 && entry.pdf <= 410)
      assert.ok(Number.isInteger(entry.depth) && entry.depth >= 0)
    }
    const chapter1 = info.outline.find((entry) => /^Chapter 1\b/.test(entry.title))
    assert.ok(chapter1, 'Chapter 1 entry is present')
    assert.equal(chapter1.title, 'Chapter 1 Vector Spaces')
    assert.equal(chapter1.pdf, 21)
    assert.equal(chapter1.printed, 1)
    assert.equal(chapter1.depth, 0)
    // A depth-2 entry proves nested outline items are flattened, not dropped.
    assert.ok(info.outline.some((entry) => entry.depth === 2))
  })

  await step('warm getInfo is cached', async () => {
    const warm = await getInfo(BOOK)
    assert.deepEqual(warm, info)
  })

  await step('second PDF: 39 pages, offset 1, outline resolved', async () => {
    const solutions = await getInfo(SOLUTIONS)
    assert.equal(solutions.pageCount, 39)
    assert.equal(solutions.printedOffset, 1)
    assert.deepEqual(solutions.labels[1], { pdf: 2, printed: 1 })
    assert.ok(solutions.outline.length >= 2)
    assert.deepEqual(solutions.outline[0], {
      title: 'Vector Spaces',
      pdf: 2,
      printed: 1,
      depth: 0,
    })
  })

  await step('no page labels/outline degrades to null/empty', async () => {
    const minimalPath = join(tempDir, 'minimal.pdf')
    await writeFile(minimalPath, Buffer.from(MINIMAL_PDF_BASE64, 'base64'))
    const minimal = await getInfo(minimalPath)
    assert.equal(minimal.pageCount, 1)
    assert.deepEqual(minimal.labels, [])
    assert.equal(minimal.printedOffset, null)
    assert.deepEqual(minimal.outline, [])
  })

  // -------------------------------------------------------------------------
  // Text + search
  // -------------------------------------------------------------------------
  await step('getPageText(344) contains "8.46 Jordan form"', async () => {
    const text = await getPageText(BOOK, 344)
    assert.ok(text.includes('8.46 Jordan form'), 'Jordan-form page text')
    assert.ok(text.startsWith('324 Chapter 8'), 'printed page number and chapter header')
    assert.equal(text, text.replace(/\s+/g, ' ').trim(), 'whitespace is normalised')
  })

  await step('text and outline stay well-formed Unicode (no lone surrogates)', async () => {
    // PDF.js emits a lone U+D835 from this book's math fonts. A lone surrogate
    // in one tool result made every later DeepSeek Messages request fail 400.
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    for (const pdf of [26, 27]) {
      const text = await getPageText(BOOK, pdf)
      assert.equal(loneSurrogate.test(text), false, `PDF page ${pdf} text is well formed`)
    }
    const info = await getInfo(BOOK)
    for (const entry of info.outline) {
      assert.equal(loneSurrogate.test(entry.title), false, `outline title is well formed: ${entry.title}`)
    }
  })

  const search = await step('searchPdf("singular value decomposition")', async () => {
    const result = await searchPdf(BOOK, 'singular value decomposition')
    assert.ok(result.hits.length > 0)
    assert.ok(result.pages >= 1)
    const hit = result.hits.find((item) => item.pdf === 293)
    assert.ok(hit, 'physical page 293 is among the hits')
    assert.equal(hit.printed, 273)
    assert.ok(Number.isInteger(hit.indexOnPage) && hit.indexOnPage >= 0)
    assert.ok(hit.snippet.toLowerCase().includes('singular value decomposition'))
    assert.ok(hit.snippet.length < 250, 'snippet stays short')
    return result
  })

  await step('searchPdf ignoreCase + limit + contextChars', async () => {
    const upper = await searchPdf(BOOK, 'SINGULAR VALUE DECOMPOSITION', {
      limit: 100,
      contextChars: 20,
    })
    assert.ok(upper.hits.some((hit) => hit.pdf === 293 && hit.printed === 273))
    assert.ok(upper.hits.every((hit) => hit.snippet.length < 150))
    assert.ok(upper.pages >= 1)

    const capped = await searchPdf(SOLUTIONS, 'the', { limit: 2 })
    assert.equal(capped.hits.length, 2, 'limit caps collected hits')
    assert.ok(capped.pages >= 1, 'page count still reflects all scanned pages')
  })

  // -------------------------------------------------------------------------
  // Query cleanup, normalisation maps, ranking (pure helpers)
  // -------------------------------------------------------------------------
  await step('cleanSearchQuery strips wrapping quotes/backticks/$…$', () => {
    assert.equal(cleanSearchQuery('"eigenvalue"'), 'eigenvalue')
    assert.equal(cleanSearchQuery("'eigenvalue'"), 'eigenvalue')
    assert.equal(cleanSearchQuery('“eigenvalue”'), 'eigenvalue')
    assert.equal(cleanSearchQuery('‘eigenvalue’'), 'eigenvalue')
    assert.equal(cleanSearchQuery('`eigenvalue`'), 'eigenvalue')
    assert.equal(cleanSearchQuery('$L(V)$'), 'L(V)')
    assert.equal(cleanSearchQuery('  "  eigenvalue  "  '), 'eigenvalue')
    assert.throws(() => cleanSearchQuery('   '), /query must be a non-empty string/)
    assert.throws(() => cleanSearchQuery('""'), /query must be a non-empty string/)
    assert.throws(() => cleanSearchQuery('x'.repeat(1001)), /longer than 1000 characters/)
  })

  await step('normalizeSearchText folds math/ligatures and line-break hyphens', () => {
    assert.equal(normalizeSearchText('ℒ (𝑉)'), 'L (V)')
    assert.equal(normalizeSearchText('ﬁnite'), 'finite')
    assert.equal(normalizeSearchText('ｆｕｌｌ'), 'full')
    assert.equal(normalizeSearchText('com- plex'), 'complex')
    assert.equal(normalizeSearchText('finite-dimensional'), 'finitedimensional')
    assert.equal(normalizeSearchText('finite dimensional'), 'finite dimensional')
  })

  await step('buildSearchLayout maps normalized/compact indices to the original', () => {
    const layout = buildSearchLayout('The ﬁnite com- plex thing')
    assert.equal(layout.original, 'The ﬁnite com- plex thing')
    assert.equal(layout.normalized, 'The finite complex thing')
    assert.equal(layout.compact, 'Thefinitecomplexthing')

    const normalizedIndex = layout.normalized.indexOf('complex')
    const originalIndex = layout.normalizedToOriginal[normalizedIndex]
    assert.equal(layout.original.slice(originalIndex, originalIndex + 9), 'com- plex')
    assert.equal(layout.compactToNormalized[layout.compact.indexOf('complex')], normalizedIndex)
    assert.equal(layout.normalizedLower, 'the finite complex thing')
  })

  await step('rankSearchHits puts body pages first and caps front matter at 3', () => {
    const hits = [
      { pdf: 1, printed: 'i', indexOnPage: 0 },
      { pdf: 21, printed: 1, indexOnPage: 5 },
      { pdf: 2, printed: 'ii', indexOnPage: 0 },
      { pdf: 22, printed: 2, indexOnPage: 0 },
      { pdf: 23, printed: 3, indexOnPage: 0 },
      { pdf: 3, printed: 'iii', indexOnPage: 0 },
      { pdf: 4, printed: 'iv', indexOnPage: 0 },
    ]
    assert.deepEqual(
      rankSearchHits(hits, { limit: 4 }).map((hit) => hit.pdf),
      [21, 22, 23, 1],
      'body first, then only enough front matter to fill the limit',
    )
    assert.deepEqual(
      rankSearchHits(hits, { limit: 10 }).map((hit) => hit.pdf),
      [21, 22, 23, 1, 2, 3],
      'at most three front-matter hits',
    )
  })

  // -------------------------------------------------------------------------
  // Normalized search against the real LADR PDFs
  // -------------------------------------------------------------------------
  const eigenvalueSearch = await step('"eigenvalue" quoted matches eigenvalue (phrase)', async () => {
    const plain = await searchPdf(BOOK, 'eigenvalue', { limit: 30 })
    const quoted = await searchPdf(BOOK, '"eigenvalue"', { limit: 30 })
    assert.ok(plain.pages > 0)
    assert.equal(plain.mode, 'phrase')
    assert.equal(quoted.mode, 'phrase')
    assert.equal(quoted.pages, plain.pages, 'quote cleanup leaves the page count unchanged')
    assert.deepEqual(
      quoted.hits.map((hit) => hit.pdf),
      plain.hits.map((hit) => hit.pdf),
      'quoted and unquoted hits agree',
    )
    return plain
  })

  await step('body-first ranking and full page count', async () => {
    assert.equal(typeof eigenvalueSearch.hits[0].printed, 'number', 'first hit is a body page')
    assert.ok(
      eigenvalueSearch.pages > eigenvalueSearch.hits.length,
      `pages (${eigenvalueSearch.pages}) counts before the limit (${eigenvalueSearch.hits.length})`,
    )

    const small = await searchPdf(BOOK, 'eigenvalue', { limit: 5 })
    assert.equal(small.hits.length, 5, 'limit is applied to the ranked hits')
    assert.ok(small.hits.every((hit) => typeof hit.printed === 'number'))
    assert.ok(small.pages > small.hits.length)

    const all = await searchPdf(BOOK, 'eigenvalue', { limit: 5000 })
    const front = all.hits.filter((hit) => typeof hit.printed !== 'number')
    assert.equal(front.length, 3, 'at most three front-matter hits are returned')
    assert.equal(all.pages, eigenvalueSearch.pages, 'pages does not depend on the limit')
    const firstFront = all.hits.findIndex((hit) => typeof hit.printed !== 'number')
    assert.equal(firstFront, all.hits.length - 3, 'front-matter hits are the tail')
  })

  await step('math query L(V) uses compact mode with original-text snippets', async () => {
    const result = await searchPdf(BOOK, 'L(V)', { limit: 5000 })
    assert.equal(result.mode, 'compact')
    assert.ok(result.pages > 0)
    assert.ok(
      result.hits.some((hit) => hit.pdf === 200),
      'PDF page 200 contains ℒ (𝑉)',
    )
    assert.ok(
      result.hits.some((hit) => hit.snippet.includes('ℒ (')),
      'snippet is cut from the original extraction',
    )
  })

  await step('hyphenation: complex also matches com- plex (pdf 140)', async () => {
    const raw = await getPageText(BOOK, 140)
    assert.ok(raw.includes('com- plex'))
    const result = await searchPdf(BOOK, 'complex', { limit: 5000 })
    const page140 = result.hits.filter((hit) => hit.pdf === 140)
    assert.ok(page140.length > 0, 'pdf 140 is among the hits')
    assert.ok(
      page140.some((hit) => hit.snippet.includes('com- plex')),
      'the snippet shows the original hyphenated text',
    )
    const literalCount = [...raw.matchAll(/complex/giu)].length
    assert.equal(page140.length, literalCount + 1, 'the line-break occurrence is found too')
  })

  await step('hyphenation: diagonalized finds diag- onalized only when normalized', async () => {
    const raw = await getPageText(BOOK, 16)
    assert.ok(raw.includes('diag- onalized'))
    assert.ok(!raw.includes('diagonalized'), 'the raw extraction has only the hyphenated form')
    const result = await searchPdf(BOOK, 'diagonalized', { limit: 5000 })
    assert.equal(result.mode, 'phrase')
    assert.ok(result.hits.some((hit) => hit.pdf === 16))
  })

  await step('terms fallback: eigenvalue complex determinant', async () => {
    const result = await searchPdf(BOOK, 'eigenvalue complex determinant', { limit: 30 })
    assert.equal(result.mode, 'terms')
    assert.ok(result.pages >= 1)
    assert.ok(result.hits.length >= 1)
    assert.equal(typeof result.hits[0].printed, 'number', 'body pages come first')
  })

  await step('pdfPages restricts the scan to a page range', async () => {
    const whole = await searchPdf(BOOK, 'eigenvalue', { limit: 5000 })
    const scoped = await searchPdf(BOOK, 'eigenvalue', { limit: 5000, pdfPages: [152, 153] })
    assert.equal(scoped.mode, 'phrase')
    assert.ok(scoped.pages >= 1 && scoped.pages <= 2, `scoped pages = ${scoped.pages}`)
    assert.ok(scoped.pages < whole.pages, 'pages counts only the scanned range')
    assert.ok(scoped.hits.length > 0)
    assert.ok(scoped.hits.every((hit) => hit.pdf === 152 || hit.pdf === 153))

    const singlePage = await searchPdf(BOOK, 'singular value decomposition', {
      limit: 5,
      pdfPages: [293],
    })
    assert.equal(singlePage.pages, 1)
    assert.ok(singlePage.hits.every((hit) => hit.pdf === 293))
    assert.equal(typeof singlePage.hits[0].printed, 'number')

    await assert.rejects(searchPdf(BOOK, 'eigenvalue', { pdfPages: [] }), /pdfPages must not be empty/)
    await assert.rejects(searchPdf(BOOK, 'eigenvalue', { pdfPages: 0 }), /must be an array/)
    await assert.rejects(searchPdf(BOOK, 'eigenvalue', { pdfPages: [0] }), /positive integers/)
    await assert.rejects(searchPdf(BOOK, 'eigenvalue', { pdfPages: [411] }), (error) => {
      assert.equal(error.code, 'PDF_PAGE_OUT_OF_RANGE')
      return true
    })
  })

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  const page344 = await step('renderPageToPng(344) at scale 2', async () => {
    const result = await renderPageToPng(BOOK, 344)
    assertPng(result, 750, 1272)
    assert.equal(result.pdf, 344)
    assert.equal(result.printed, 324)
    assert.ok(result.buffer.length > 100 * 1024, `PNG is ${result.buffer.length} bytes (> 100 KB)`)
    return result
  })

  await step('rendered PNG is written and readable from disk', async () => {
    const pngPath = join(tempDir, 'page-344.png')
    await writeFile(pngPath, page344.buffer)
    const file = await stat(pngPath)
    assert.equal(file.size, page344.buffer.length)
    assert.ok(file.size > 100 * 1024)
  })

  await step('crop honours page fractions', async () => {
    const result = await renderPageToPng(BOOK, 344, {
      scale: 2,
      crop: { x: 0, y: 0, w: 1, h: 0.55 },
    })
    assertPng(result, 750, 700)
    assert.ok(result.buffer.length > 50 * 1024)
  })

  await step('renderPagesToPng([344,345,346]) keeps order', async () => {
    const results = await renderPagesToPng(BOOK, [344, 345, 346], { scale: 2 })
    assert.equal(results.length, 3)
    assert.deepEqual(
      results.map((result) => result.pdf),
      [344, 345, 346],
    )
    for (const result of results) {
      assertPng(result, 750, 1272)
      assert.ok(result.buffer.length > 50 * 1024)
    }
    assert.equal(results[0].printed, 324)
    assert.equal(results[1].printed, 325)
  })

  await step('empty page list returns []', async () => {
    assert.deepEqual(await renderPagesToPng(BOOK, []), [])
  })

  // -------------------------------------------------------------------------
  // Errors / robustness
  // -------------------------------------------------------------------------
  await step('invalid page / scale / crop / query throw clear errors', async () => {
    await assert.rejects(getPageText(BOOK, 0), /between 1 and 410/)
    await assert.rejects(getPageText(BOOK, 411), /between 1 and 410/)
    await assert.rejects(renderPageToPng(BOOK, 344, { scale: 4 }), /scale must be a number between 1 and 3/)
    await assert.rejects(
      renderPageToPng(BOOK, 344, { crop: { x: 0.5, y: 0, w: 0.6, h: 0.5 } }),
      /crop must satisfy/,
    )
    await assert.rejects(searchPdf(BOOK, '   '), /query must be a non-empty string/)
    await assert.rejects(searchPdf(BOOK, '""'), /query must be a non-empty string/)
    await assert.rejects(searchPdf(BOOK, '---'), /query must be a non-empty string/)
    await assert.rejects(searchPdf(BOOK, 'x', { limit: 0 }), /limit must be a positive integer/)
  })

  await step('missing file -> PDF_NOT_FOUND', async () => {
    await assert.rejects(getInfo(join(tempDir, 'does-not-exist.pdf')), (error) => {
      assert.equal(error.code, 'PDF_NOT_FOUND')
      assert.match(error.message, /PDF not found/)
      return true
    })
  })

  await step('corrupt file -> PDF_CORRUPT', async () => {
    const corruptPath = join(tempDir, 'corrupt.pdf')
    await writeFile(corruptPath, '%PDF-1.4\nthis is not a pdf\n')
    await assert.rejects(getInfo(corruptPath), (error) => {
      assert.equal(error.code, 'PDF_CORRUPT')
      assert.match(error.message, /corrupt or not a valid PDF/)
      return true
    })
  })

  await step('encrypted file -> PDF_ENCRYPTED', async () => {
    const encryptedPath = join(tempDir, 'encrypted.pdf')
    await writeFile(encryptedPath, Buffer.from(ENCRYPTED_PDF_BASE64, 'base64'))
    await assert.rejects(getInfo(encryptedPath), (error) => {
      assert.equal(error.code, 'PDF_ENCRYPTED')
      assert.match(error.message, /encrypted or password-protected/)
      return true
    })
  })

  // -------------------------------------------------------------------------
  // Cache eviction / reopen
  // -------------------------------------------------------------------------
  await step('closePdf evicts and reopen works', async () => {
    assert.equal(await closePdf(BOOK), true)
    assert.equal(await closePdf(BOOK), false, 'second close is a no-op')
    const reopened = await getInfo(BOOK)
    assert.equal(reopened.pageCount, 410)
    assert.equal(reopened.outline.length, info.outline.length)
  })

  console.log(`\nAll ${checks} checks passed.`)
  console.log(`  search hits: ${search.hits.length} on ${search.pages} page(s)`)
  console.log('\nMeasured timings (same process):')
  for (const [name, ms] of timings) console.log(`  ${name.padEnd(48)} ${ms.toFixed(1)} ms`)
} finally {
  await closePdf(BOOK)
  await closePdf(SOLUTIONS)
  await rm(tempDir, { recursive: true, force: true })
}
