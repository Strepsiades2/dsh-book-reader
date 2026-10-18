/**
 * DeepSeek vision token accounting — a verbatim port of the provider's
 * published calculator as implemented by DSH in
 * `@deepseek-ai/dsh-llm-deepseek` (`image-tokens` module, `v41` config).
 *
 * An image is scaled up below 544x544, aligned to a 14px patch grid,
 * downsampled 3:1 per axis into token cells, and capped at 1024 tokens.
 *   tokens = gridHeight * (gridWidth + 1) + 2
 */

const PATCH_SIZE = 14
const DOWNSAMPLE_RATIO = 3
const MAX_IMAGE_TOKENS = 1024
const MIN_PIXELS = 544 * 544
const CELL_SIZE = PATCH_SIZE * DOWNSAMPLE_RATIO

const intDiv = (value, divisor) => Math.floor(value / divisor)
const ceilDiv = (value, divisor) => Math.floor((value + divisor - 1) / divisor)
const gridTokens = (gridHeight, gridWidth) => gridHeight * (gridWidth + 1) + 2
const gridCells = (paddedLength) => ceilDiv(intDiv(paddedLength, PATCH_SIZE), DOWNSAMPLE_RATIO)

function solveResizeRatio(height, width, budget) {
  const aspect = height / width
  const idealGridWidth = Math.sqrt((budget - 2) / aspect + 0.25) - 0.5
  const idealGridHeight = idealGridWidth * aspect
  let bestHeight
  let bestWidth
  if (idealGridWidth < 1) {
    bestWidth = CELL_SIZE
    bestHeight = intDiv(budget - 2, 2) * CELL_SIZE
  } else if (idealGridHeight < 1) {
    bestWidth = (intDiv(budget - 2, 1) - 1) * CELL_SIZE
    bestHeight = CELL_SIZE
  } else {
    const gridWidth = Math.trunc(idealGridWidth)
    const gridHeight = Math.trunc(idealGridHeight)
    const scale = Math.min((gridWidth * CELL_SIZE) / width, (gridHeight * CELL_SIZE) / height)
    bestWidth = Math.trunc((width * scale) / PATCH_SIZE) * PATCH_SIZE
    bestHeight = Math.trunc((height * scale) / PATCH_SIZE) * PATCH_SIZE
  }
  const gh = gridCells(bestHeight)
  const gw = gridCells(bestWidth)
  return { gridHeight: gh, gridWidth: gw, bestHeight, bestWidth, numTokens: gridTokens(gh, gw) }
}

function safeResize(height, width, paddedHeight, paddedWidth) {
  const gridHeight = gridCells(paddedHeight)
  const gridWidth = gridCells(paddedWidth)
  const direct = {
    gridHeight,
    gridWidth,
    bestHeight: paddedHeight,
    bestWidth: paddedWidth,
    numTokens: gridTokens(gridHeight, gridWidth),
  }
  if (direct.numTokens <= MAX_IMAGE_TOKENS) return direct
  return solveResizeRatio(height, width, MAX_IMAGE_TOKENS)
}

function resizeOnce(width, height) {
  let scaledWidth = width
  let scaledHeight = height
  const pixels = scaledWidth * scaledHeight
  if (pixels < MIN_PIXELS && pixels > 0) {
    const scale = Math.sqrt(MIN_PIXELS / pixels)
    scaledWidth = Math.trunc(scaledWidth * scale)
    scaledHeight = Math.trunc(scaledHeight * scale)
  }
  const paddedWidth = ceilDiv(scaledWidth, PATCH_SIZE) * PATCH_SIZE
  const paddedHeight = ceilDiv(scaledHeight, PATCH_SIZE) * PATCH_SIZE
  return safeResize(scaledHeight, scaledWidth, paddedHeight, paddedWidth)
}

const sameResize = (a, b) =>
  a.gridHeight === b.gridHeight &&
  a.gridWidth === b.gridWidth &&
  a.bestHeight === b.bestHeight &&
  a.bestWidth === b.bestWidth &&
  a.numTokens === b.numTokens

/**
 * Exact DeepSeek vision-token count for one image of these pixel dimensions.
 * @param {number} width - image width in pixels.
 * @param {number} height - image height in pixels.
 * @returns {{numTokens: number, gridWidth: number, gridHeight: number}}
 */
export function estimateImageTokens(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { numTokens: 0, gridWidth: 0, gridHeight: 0 }
  }
  let current = resizeOnce(width, height)
  for (let i = 0; i < 8; i += 1) {
    const next = resizeOnce(current.bestWidth, current.bestHeight)
    if (sameResize(current, next)) return { numTokens: next.numTokens, gridWidth: next.gridWidth, gridHeight: next.gridHeight }
    current = next
  }
  return { numTokens: current.numTokens, gridWidth: current.gridWidth, gridHeight: current.gridHeight }
}

/**
 * Rough text-token estimate for the cheap tools (~4 chars/token for English
 * prose; CJK is closer to 1-1.5). Deliberately conservative: it is used only
 * for cost reporting, never for billing.
 * @param {string} text - text to estimate.
 * @returns {number} approximate token count.
 */
export function estimateTextTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let ascii = 0
  let wide = 0
  for (const ch of text) {
    if (ch.codePointAt(0) > 0x2e7f) wide += 1
    else ascii += 1
  }
  return Math.ceil(ascii / 4) + wide
}
