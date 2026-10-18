// pdfkit.swift — macOS PDFKit helper for the dsh-pdf-reader workflow.
//
// Subcommands:
//   info   <pdf>                         page count, page labels, document outline (TOC)
//   text   <pdf> [--pages 1-20,25] [--out file]
//   render <pdf> --pages 1-3,7 [--scale 2] [--out dir] [--prefix page]
//   search <pdf> --query "theorem 1.2" [--ignore-case] [--context 60]
//
// Build (sandbox-safe; the clang module cache must live under the workspace):
//   TMPDIR="$PWD/.tmp" swiftc -module-cache-path "$PWD/.swiftcache" -O \
//     dsh-pdf-reader/tools/pdfkit.swift -o dsh-pdf-reader/tools/pdfkit
//
// Why Swift/PDFKit: macOS already has a reliable PDF engine with the page
// label and outline information that raw text extraction loses. Rendered PNGs
// preserve math typesetting; `read_image` can then carry them to the vision
// model.

import Foundation
import AppKit
import PDFKit

// MARK: - small CLI parser

struct Args {
    var command: String = ""
    var pdf: String = ""
    var pages: String? = nil
    var out: String? = nil
    var scale: Double = 2.0
    var prefix: String = "page"
    var query: String? = nil
    var ignoreCase: Bool = false
    var context: Int = 60
    /// Optional crop as fractions of the page with a TOP-LEFT origin:
    /// "x0,y0,x1,y1" where (0,0) is the top-left and (1,1) the bottom-right.
    var crop: String? = nil

    static func parse(_ argv: [String]) -> Args {
        var a = Args()
        var rest = argv
        guard !rest.isEmpty else { return a }
        a.command = rest.removeFirst()
        while !rest.isEmpty {
            let arg = rest.removeFirst()
            switch arg {
            case "--pages": a.pages = rest.first; if !rest.isEmpty { rest.removeFirst() }
            case "--out": a.out = rest.first; if !rest.isEmpty { rest.removeFirst() }
            case "--scale": a.scale = Double(rest.first ?? "") ?? 2.0; if !rest.isEmpty { rest.removeFirst() }
            case "--prefix": a.prefix = rest.first ?? "page"; if !rest.isEmpty { rest.removeFirst() }
            case "--query", "-q": a.query = rest.first; if !rest.isEmpty { rest.removeFirst() }
            case "--context": a.context = Int(rest.first ?? "") ?? 60; if !rest.isEmpty { rest.removeFirst() }
            case "--crop": a.crop = rest.first; if !rest.isEmpty { rest.removeFirst() }
            case "--ignore-case", "-i": a.ignoreCase = true
            case "--help", "-h":
                printUsage(); exit(0)
            default:
                if arg.hasPrefix("-") {
                    FileHandle.standardError.write("unknown option \(arg)\n".data(using: .utf8)!)
                    exit(2)
                }
                if a.pdf.isEmpty { a.pdf = arg }
            }
        }
        return a
    }
}

func printUsage() {
    print("""
    usage: pdfkit <info|text|render|search> <pdf> [options]

      info    <pdf>
      text    <pdf> [--pages 1-20,25] [--out file]
      render  <pdf> --pages 1-3,7 [--scale 2] [--out dir] [--prefix page]
              [--crop x0,y0,x1,y1]   fractions, top-left origin
      search  <pdf> --query "term" [--ignore-case] [--context 60]
    """)
}

// MARK: - page ranges

/// Parse "1-3,7,10-12". 1-based, inclusive. nil means all pages.
func parseRanges(_ spec: String?, pageCount: Int) -> [Int] {
    guard let spec = spec, !spec.isEmpty else { return Array(1...pageCount) }
    var result: [Int] = []
    var seen = Set<Int>()
    for chunk in spec.split(separator: ",") {
        let part = chunk.trimmingCharacters(in: .whitespaces)
        if part.isEmpty { continue }
        if part.contains("-") {
            let bits = part.split(separator: "-", maxSplits: 1).map(String.init)
            guard bits.count == 2, let lo = Int(bits[0]), let hi = Int(bits[1]) else {
                FileHandle.standardError.write("bad page range: \(part)\n".data(using: .utf8)!)
                exit(2)
            }
            let a = max(1, min(lo, hi)), b = min(pageCount, max(lo, hi))
            if a <= b { for p in a...b where seen.insert(p).inserted { result.append(p) } }
        } else if let p = Int(part), p >= 1, p <= pageCount {
            if seen.insert(p).inserted { result.append(p) }
        }
    }
    return result
}

// MARK: - document

struct OpenDoc {
    let doc: PDFDocument
    let url: URL
}

func openDocument(_ path: String) -> OpenDoc {
    let url = URL(fileURLWithPath: path).standardizedFileURL
    guard FileManager.default.fileExists(atPath: url.path) else {
        FileHandle.standardError.write("no such file: \(url.path)\n".data(using: .utf8)!)
        exit(1)
    }
    guard let doc = PDFDocument(url: url) else {
        FileHandle.standardError.write("cannot open PDF: \(url.path)\n".data(using: .utf8)!)
        exit(1)
    }
    if doc.isLocked {
        FileHandle.standardError.write("PDF is locked (password protected): \(url.path)\n".data(using: .utf8)!)
        exit(1)
    }
    return OpenDoc(doc: doc, url: url)
}

func pageLabel(_ doc: PDFDocument, _ index: Int) -> String? {
    guard let page = doc.page(at: index) else { return nil }
    // PDFPage.label gives the printed label (e.g. "xii") when the PDF defines
    // one; fall back to nil so callers can print the physical page number.
    let label = page.label
    return (label?.isEmpty == false) ? label : nil
}

func oneLine(_ s: String) -> String {
    s.replacingOccurrences(of: "\n", with: " ")
        .replacingOccurrences(of: "\r", with: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

// MARK: - commands

func printOutline(_ doc: PDFDocument, node: PDFOutline?, depth: Int, maxDepth: Int = 4) {
    guard let node = node else { return }
    for i in 0..<node.numberOfChildren {
        guard let child = node.child(at: i) else { continue }
        let label = child.label ?? "(untitled)"
        var pageText = "?"
        if let dest = child.destination, let page = dest.page {
            let idx = doc.index(for: page) + 1
            if idx > 0 { pageText = "p\(idx)" }
        } else if let action = child.action, let dest = action as? PDFActionGoTo,
                  let page = dest.destination.page {
            pageText = "p\(doc.index(for: page) + 1)"
        }
        if pageText != "?", let idx = Int(pageText.dropFirst()), let printed = pageLabel(doc, idx - 1) {
            pageText += " \u{00b7} printed \(printed)"
        }
        print(String(repeating: "  ", count: depth) + "- \(oneLine(label))  [\(pageText)]")
        if depth + 1 < maxDepth { printOutline(doc, node: child, depth: depth + 1, maxDepth: maxDepth) }
    }
}

func cmdInfo(_ a: Args) {
    let od = openDocument(a.pdf)
    let doc = od.doc
    print("path: \(od.url.path)")
    print("pages: \(doc.pageCount)")
    print("locked: \(doc.isLocked)")
    if let attrs = doc.documentAttributes {
        if let title = attrs[PDFDocumentAttribute.titleAttribute] { print("title: \(oneLine("\(title)"))") }
        if let author = attrs[PDFDocumentAttribute.authorAttribute] { print("author: \(oneLine("\(author)"))") }
    }
    // Page labels, compacted into runs: "1=1", "2=2", ... and "1=x, 2=xi".
    var labels: [String] = []
    for i in 0..<min(doc.pageCount, 30) {
        let physical = i + 1
        if let l = pageLabel(doc, i) { labels.append("\(physical)=\(l)") }
    }
    if !labels.isEmpty {
        print("page-labels(first 30): \(labels.joined(separator: ", "))")
    }
    // Dominant physical-minus-printed offset for numeric page labels, so the
    // caller never has to guess how a printed page maps to a PDF page index.
    var deltas: [Int: Int] = [:]
    for i in 0..<doc.pageCount {
        if let l = pageLabel(doc, i), let printed = Int(l) { deltas[i + 1 - printed, default: 0] += 1 }
    }
    if let best = deltas.max(by: { $0.value < $1.value }) {
        print("printed-page-offset: physical = printed + \(best.key)  (\(best.value) numeric labels agree)")
    }
    if let root = doc.outlineRoot, root.numberOfChildren > 0 {
        print("outline:")
        printOutline(doc, node: root, depth: 1)
    } else {
        print("outline: (none)")
    }
}

func cmdText(_ a: Args) {
    let od = openDocument(a.pdf)
    let doc = od.doc
    let pages = parseRanges(a.pages, pageCount: doc.pageCount)
    var out = ""
    for p in pages {
        guard let page = doc.page(at: p - 1) else { continue }
        let label = pageLabel(doc, p - 1).map { " label=\($0)" } ?? ""
        out += "\n===== PAGE \(p)/\(doc.pageCount)\(label) =====\n"
        let text = page.string ?? ""
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            out += "[no text layer — likely a scanned page; render it instead]\n"
        } else {
            out += text
            if !out.hasSuffix("\n") { out += "\n" }
        }
    }
    if let path = a.out {
        do {
            try out.write(toFile: path, atomically: true, encoding: .utf8)
            FileHandle.standardError.write("wrote \(pages.count) pages to \(path)\n".data(using: .utf8)!)
        } catch {
            FileHandle.standardError.write("write failed: \(error)\n".data(using: .utf8)!)
            exit(1)
        }
    } else {
        print(out)
    }
}

func cmdRender(_ a: Args) {
    let od = openDocument(a.pdf)
    let doc = od.doc
    let pages = parseRanges(a.pages, pageCount: doc.pageCount)
    let outDir = URL(fileURLWithPath: a.out ?? FileManager.default.currentDirectoryPath + "/.tmp/pages")
    do {
        try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
    } catch {
        FileHandle.standardError.write("cannot create output dir \(outDir.path): \(error)\n".data(using: .utf8)!)
        exit(1)
    }
    let scale = max(0.5, min(a.scale, 4.0))
    // Crop fractions are top-left based; PDF page coordinates are bottom-left.
    var cropRect: CGRect? = nil
    if let spec = a.crop {
        let nums = spec.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        if nums.count == 4, nums[0] >= 0, nums[1] >= 0, nums[2] <= 1, nums[3] <= 1,
           nums[0] < nums[2], nums[1] < nums[3] {
            cropRect = CGRect(x: nums[0], y: nums[1], width: nums[2] - nums[0], height: nums[3] - nums[1])
        } else {
            FileHandle.standardError.write("bad --crop (want x0,y0,x1,y1 fractions, top-left origin)\n".data(using: .utf8)!)
            exit(2)
        }
    }
    var totalBytes = 0
    for p in pages {
        guard let page = doc.page(at: p - 1) else { continue }
        let media = page.bounds(for: .mediaBox)
        let fractions = cropRect ?? CGRect(x: 0, y: 0, width: 1, height: 1)
        let target = CGRect(
            x: media.minX + fractions.minX * media.width,
            y: media.minY + (1 - fractions.maxY) * media.height,
            width: fractions.width * media.width,
            height: fractions.height * media.height
        )
        let w = max(1, Int(round(target.width * scale)))
        let h = max(1, Int(round(target.height * scale)))
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h,
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                         isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0) else {
            FileHandle.standardError.write("cannot allocate bitmap for page \(p)\n".data(using: .utf8)!)
            exit(1)
        }
        // rep.size is in points; pixels are scale times larger, so the graphics
        // context already has the right device scale. Do NOT scale the CTM here:
        // doing so on top of rep.size crops the page to a magnified quadrant.
        rep.size = NSSize(width: target.width, height: target.height)
        guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else {
            FileHandle.standardError.write("cannot create graphics context\n".data(using: .utf8)!)
            exit(1)
        }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        // Matte white page on the transparent bitmap, then draw the PDF page.
        NSColor.white.setFill()
        NSRect(x: 0, y: 0, width: target.width, height: target.height).fill()
        ctx.cgContext.translateBy(x: -target.minX, y: -target.minY)
        page.draw(with: .mediaBox, to: ctx.cgContext)
        NSGraphicsContext.restoreGraphicsState()

        guard let data = rep.representation(using: .png, properties: [:]) else {
            FileHandle.standardError.write("PNG encode failed for page \(p)\n".data(using: .utf8)!)
            exit(1)
        }
        let suffix = cropRect == nil ? "" : "-crop"
        let name = "\(a.prefix)-\(String(format: "%03d", p))\(suffix).png"
        let file = outDir.appendingPathComponent(name)
        do {
            try data.write(to: file)
        } catch {
            FileHandle.standardError.write("write failed \(file.path): \(error)\n".data(using: .utf8)!)
            exit(1)
        }
        totalBytes += data.count
        print("\(file.path)\t\(w)x\(h)\t\(data.count) bytes")
    }
    FileHandle.standardError.write("rendered \(pages.count) page(s), \(totalBytes) bytes total\n".data(using: .utf8)!)
}

func cmdSearch(_ a: Args) {
    let od = openDocument(a.pdf)
    let doc = od.doc
    guard let q = a.query, !q.isEmpty else {
        FileHandle.standardError.write("search needs --query\n".data(using: .utf8)!)
        exit(2)
    }
    let opts: String.CompareOptions = a.ignoreCase ? [.caseInsensitive] : []
    var hits = 0
    var pageHits = 0
    for i in 0..<doc.pageCount {
        guard let text = doc.page(at: i)?.string else { continue }
        let ns = text as NSString
        var searchRange = NSRange(location: 0, length: ns.length)
        var local = 0
        while searchRange.length > 0 {
            let found = ns.range(of: q, options: opts, range: searchRange)
            if found.location == NSNotFound { break }
            if local == 0 { pageHits += 1 }
            local += 1
            hits += 1
            let start = max(0, found.location - a.context)
            let end = min(ns.length, found.location + found.length + a.context)
            let snippet = oneLine(ns.substring(with: NSRange(location: start, length: end - start)))
            print("p\(i + 1)\t#\(local)\t\(snippet)")
            let next = found.location + max(found.length, 1)
            if next >= ns.length { break }
            searchRange = NSRange(location: next, length: ns.length - next)
        }
    }
    FileHandle.standardError.write("\(hits) hit(s) on \(pageHits) page(s)\n".data(using: .utf8)!)
    if hits == 0 { exit(3) }
}

// MARK: - main

let argv = Array(CommandLine.arguments.dropFirst())
let a = Args.parse(argv)
switch a.command {
case "info": cmdInfo(a)
case "text": cmdText(a)
case "render": cmdRender(a)
case "search": cmdSearch(a)
default:
    printUsage()
    exit(2)
}
