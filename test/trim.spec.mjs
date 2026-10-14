/**
 * The reduction itself, measured without a session, a clock or a tool.
 *
 * `trimContent` is pure by construction — it reads only its arguments — so these
 * arms are the whole specification of what "head, marker, tail" means, including
 * the exact places the shipped pruner's own shape is deliberately matched and the
 * one place it is not (the marker).
 *
 * @module test/trim.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TRIM_MARKER, codePointLength, measureContent, resolveConfig, trimContent } from '../lib/index.js'
import { body } from './harness.mjs'

/** A budget small enough that a short fixture is already over it. */
const SMALL = resolveConfig({ thresholdChars: 120, headChars: 20, tailChars: 10 })

/** The text of a block list, joined. */
const textOf = blocks => blocks.map(block => block.text ?? '').join('')

describe('measureContent', () => {
  it('counts only text blocks', () => {
    assert.equal(measureContent([{ type: 'text', text: 'abc' }]), 3)
    assert.equal(measureContent([{ type: 'text', text: 'abc' }, { type: 'text', text: 'de' }]), 5)
    assert.equal(measureContent([{ type: 'image', attachment: { attachmentId: 'x', mediaType: 'image/png' } }]), 0)
  })

  it('counts code points, so an astral character is one', () => {
    assert.equal(measureContent([{ type: 'text', text: '😀😀' }]), 2)
  })

  it('is zero for an empty block list', () => {
    assert.equal(measureContent([]), 0)
  })
})

describe('trimContent', () => {
  it('leaves a result within budget alone', () => {
    assert.equal(trimContent([{ type: 'text', text: 'short' }], SMALL), null)
  })

  it('leaves a result exactly at the threshold alone', () => {
    // The boundary is inclusive: a result of exactly `thresholdChars` is not
    // over budget, and the only alternative reading would trim a result whose
    // replacement is by construction the same size.
    const text = 'x'.repeat(SMALL.thresholdChars)
    assert.equal(codePointLength(text), SMALL.thresholdChars)
    assert.equal(trimContent([{ type: 'text', text }], SMALL), null)
  })

  it('keeps the head, the tail and one marker', () => {
    const text = body(400, 'A')
    const trimmed = trimContent([{ type: 'text', text }], SMALL)
    assert.notEqual(trimmed, null)
    const out = textOf(trimmed)
    assert.equal(out, text.slice(0, SMALL.headChars) + TRIM_MARKER + text.slice(-SMALL.tailChars))
    assert.ok(out.startsWith('[A-HEAD]'))
    assert.ok(out.endsWith('[A-TAIL]'))
  })

  it('produces a replacement strictly smaller than the text it replaces', () => {
    for (const chars of [121, 200, 4_000]) {
      const text = 'y'.repeat(chars)
      const trimmed = trimContent([{ type: 'text', text }], SMALL)
      assert.notEqual(trimmed, null)
      assert.ok(measureContent(trimmed) < chars)
      assert.ok(measureContent(trimmed) <= SMALL.thresholdChars)
    }
  })

  it('inserts the marker once even when the removed span crosses blocks', () => {
    const blocks = [
      { type: 'text', text: 'a'.repeat(60) },
      { type: 'text', text: 'b'.repeat(60) },
      { type: 'text', text: 'c'.repeat(60) },
    ]
    const trimmed = trimContent(blocks, SMALL)
    assert.notEqual(trimmed, null)
    const out = textOf(trimmed)
    assert.equal(out.split(TRIM_MARKER).length - 1, 1)
    // The first 20 code points survive, the last 10 do, and nothing between them
    // does — the elision reads as one gap, not one per block.
    assert.ok(out.startsWith('a'.repeat(20)))
    assert.ok(out.endsWith('c'.repeat(10)))
    assert.ok(!out.includes('b'.repeat(20)))
  })

  it('carries non-text blocks through in place', () => {
    const image = { type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png' } }
    const trimmed = trimContent([
      { type: 'text', text: 'h'.repeat(150) },
      image,
      { type: 'text', text: 't'.repeat(50) },
    ], SMALL)
    assert.notEqual(trimmed, null)
    assert.ok(trimmed.includes(image))
    // The image still sits between the retained head and the retained tail.
    assert.equal(trimmed[1], image)
  })

  it('leaves a result whose weight is not text alone', () => {
    // Nothing here is text, so there is no middle to drop and the honest outcome
    // is to say so rather than to pretend it was bounded.
    const trimmed = trimContent([
      { type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png' } },
      { type: 'image', attachment: { attachmentId: 'b', mediaType: 'image/png' } },
    ], SMALL)
    assert.equal(trimmed, null)
  })

  it('drops blocks that the reduction emptied', () => {
    const blocks = [
      { type: 'text', text: 'z'.repeat(200) },
      { type: 'text', text: 'w'.repeat(200) },
    ]
    const trimmed = trimContent(blocks, resolveConfig({ thresholdChars: 80, headChars: 0, tailChars: 0 }))
    assert.notEqual(trimmed, null)
    // Both middles are removed and only the single marker survives, so the
    // block list holds exactly one block rather than two empty ones.
    assert.equal(trimmed.length, 1)
    assert.equal(textOf(trimmed), TRIM_MARKER)
  })

  it('never splits a surrogate pair at a retained boundary', () => {
    // The head boundary lands after an astral character. Slicing by UTF-16 code
    // unit would keep a lone high surrogate, which is not valid text and is what
    // a provider rejects.
    const text = '😀'.repeat(80)
    const trimmed = trimContent([{ type: 'text', text }], resolveConfig({ thresholdChars: 78, headChars: 3, tailChars: 2 }))
    assert.notEqual(trimmed, null)
    const out = textOf(trimmed)
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(out.replace(TRIM_MARKER, '')))
    assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(out.replace(TRIM_MARKER, '')))
  })

  it('returns new blocks rather than mutating the input', () => {
    const original = [{ type: 'text', text: 'q'.repeat(300) }]
    const snapshot = structuredClone(original)
    trimContent(original, SMALL)
    assert.deepEqual(original, snapshot)
  })

  it('uses the plugin\u2019s own marker, not the shipped pruner\u2019s', () => {
    const trimmed = trimContent([{ type: 'text', text: 'm'.repeat(300) }], SMALL)
    assert.notEqual(trimmed, null)
    assert.ok(textOf(trimmed).includes(TRIM_MARKER))
    assert.ok(!textOf(trimmed).includes('tool result middle pruned'))
  })
})
