/**
 * The deterministic text reduction itself: measure a tool result, and — when it
 * is over budget — keep its head, keep its tail, and replace the middle with one
 * marker.
 *
 * This is pure. Nothing here reads a session, looks at a clock, or depends on
 * which tool produced the content, so the arms that measure it need no world at
 * all.
 *
 * ## Why the middle
 *
 * Tool output is not a document. A `read_file`, a test log, a `git diff` or a
 * `bash` transcript usually states what it is at the top — path, command, exit
 * status, the first error — and summarizes itself at the bottom — the failing
 * count, the summary line, the trailing prompt. The middle is where a file
 * repeats itself. That is the same reasoning the shipped pruner is built on, and
 * this module deliberately keeps its shape so the two producers cannot disagree
 * about what "the middle" means.
 *
 * ## Boundaries are code points, not code units
 *
 * Slicing by UTF-16 code unit can cut a surrogate pair in half and leave a lone
 * surrogate in the request. Slicing by code point cannot. Grapheme clusters are
 * still cut — a family emoji or a combining accent may be split — and that is
 * accepted: the alternative is a grapheme segmenter for every block, and a
 * half-cluster is harmless next to a broken surrogate.
 *
 * ## Non-text blocks pass through untouched
 *
 * An image, a resource reference or any other rich block is not text and has no
 * middle to drop; it is carried over in place, and only the text around it is
 * measured. A result whose weight is entirely in non-text blocks is therefore
 * left alone, which is the honest outcome — this plugin bounds text bytes, not
 * bytes generally.
 *
 * @module @argszero/dsh-tool-output-budget/trim
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { codePointLength, TRIM_MARKER } from './config.ts'
import type { ResolvedConfig } from './types.ts'

/**
 * Measure the text weight of one result's content.
 * @param blocks - tool-result content to measure.
 * @returns total Unicode code points across its text blocks.
 */
export function measureContent(blocks: readonly ContentBlock[]): number {
  let chars = 0
  for (const block of blocks) {
    if (block.type === 'text') chars += codePointLength(block.text)
  }
  return chars
}

/**
 * Replace an over-budget text middle while retaining rich-block order.
 *
 * The marker is inserted once, at the first text block that intersects the
 * removed span, so a multi-block result reads as one elision rather than one per
 * block.
 * @param blocks - original tool-result content.
 * @param config - resolved budgets.
 * @returns the reduced content, or `null` when the text is within budget.
 * @throws {Error} when a validated configuration produced a non-reducing
 *   replacement — unreachable for a configuration `resolveConfig` accepted, and
 *   asserted rather than trusted because a silent no-op would leave the surface
 *   unchanged while reporting a trim.
 */
export function trimContent(
  blocks: readonly ContentBlock[],
  config: ResolvedConfig,
): ContentBlock[] | null {
  const totalChars = measureContent(blocks)
  if (totalChars <= config.thresholdChars) return null

  const removedStart = config.headChars
  const removedEnd = totalChars - config.tailChars
  const trimmed: ContentBlock[] = []
  let consumed = 0
  let markerInserted = false

  for (const block of blocks) {
    if (block.type !== 'text') {
      trimmed.push(block)
      continue
    }

    const points = Array.from(block.text)
    const blockStart = consumed
    const blockEnd = blockStart + points.length
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
    const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart
    const marker = intersectsRemoved && !markerInserted ? TRIM_MARKER : ''
    if (marker.length > 0) markerInserted = true
    const text = points.slice(0, headEnd).join('')
      + marker
      + points.slice(tailStart).join('')
    if (text.length > 0) trimmed.push({ ...block, text })
    consumed = blockEnd
  }

  /* v8 ignore next -- totalChars > threshold and a validated budget guarantee a removed text span. */
  if (!markerInserted) throw new Error('tool-output-budget: failed to locate the removed text span')
  const charsAfter = measureContent(trimmed)
  /* v8 ignore next -- resolveConfig fixes the emitted head + marker + tail budget. */
  if (charsAfter > config.thresholdChars || charsAfter >= totalChars) {
    throw new Error('tool-output-budget: replacement must be smaller and within threshold')
  }
  return trimmed
}
