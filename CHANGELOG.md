# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-10-18

First public release.

### Added

- Toolbar controls on DSH's official PDF preview: previous/next page, printed
  and physical page readout with a jump box, full-text search panel
  (`Cmd/Ctrl+Shift+F`), share-page reference insertion, and an AI reading-position
  toggle.
- Hover explanations for every toolbar control, in the active DSH UI language
  (English and Simplified Chinese).
- Four model-facing tools: `pdf_info` (page map and outline), `pdf_search`
  (literal full-text search), `pdf_read_pages` (text first, optional page
  images), and `pdf_current_page` (what the user is reading).
- Per-turn reading-position injection behind `agent/pre-step`, debounced and
  rate-limited.
- Local JSON routes for the browser half, loopback-only and restricted by
  `routeAllowedRoots` / the session workspace by default.
- Bundle display metadata: localized title/description and an SVG icon for the
  DSH Plugins page.

### Notes

- Depends on the official preview's private DOM markers; DSH upgrades may change
  them.
- `pdfjs-dist` is pinned to `6.3.289` to match the host process.
- MIT licensed.

[0.1.0]: https://github.com/strepsiades/dsh-book-reader/releases/tag/v0.1.0
