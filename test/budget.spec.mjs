/**
 * What the plugin does to a live session: which results it bounds, which it
 * leaves alone, when the write happens, and what it says about it.
 *
 * The world is real (see `harness.mjs`), so an arm here that passes passes for
 * the same reason the shipped loop would reach the same surface. Where an arm is
 * about a refusal, the control arm — the same fixture with nothing mounted — is
 * run beside it, so "the plugin bounded this" can never be satisfied by the
 * fixture being small.
 *
 * @module test/budget.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import plugin, { TRIM_MARKER } from '../lib/index.js'
import {
  agentFor,
  body,
  budgetSession,
  appendResult,
  closeTurn,
  eventsOfType,
  flush,
  preStep,
  surfaceResultCount,
  surfaceResultText,
  surfaceSeqs,
  surfaceText,
  surfaceTextOfSeq,
  world,
} from './harness.mjs'

/** A budget that a `body(600)` result is comfortably over. */
const SMALL = { thresholdChars: 200, headChars: 40, tailChars: 20 }

/** The seq of the last appended `tool/result` of a fixture. */
function lastResultSeq(session) {
  const results = eventsOfType(session, 'tool/result')
  return results[results.length - 1].seq
}

describe('the defect the plugin addresses', () => {
  it('leaves an over-budget result unbounded when nothing is mounted', async () => {
    // The control for every arm below: the same 600-code-point result, the same
    // publication path, nothing listening.
    const w = await world({ mounted: false })
    const text = body(600, 'CTRL')
    const session = w.session({ results: [{ text }] })
    await flush()
    assert.equal(surfaceText(session).includes(text), true)
    assert.equal(eventsOfType(session, 'tool/result').length, 1)
  })
})

describe('bounding a result', () => {
  it('replaces an over-budget result once the appending call stack unwinds', async () => {
    const w = await world({ config: SMALL })
    const text = body(600, 'A')
    const session = w.session({ results: [{ text }] })
    const originalSeq = lastResultSeq(session)

    // Nothing happens inside the append's own stack — that is the whole reason
    // the write is deferred.
    assert.equal(surfaceResultText(session, 'call-1'), text)

    await flush()
    const shown = surfaceResultText(session, 'call-1')
    assert.equal(surfaceResultCount(session, 'call-1'), 1)
    // The replacement shadows the node it read: the original seq is no longer on
    // the surface, so one result has not become two.
    assert.equal(surfaceSeqs(session).includes(originalSeq), false)
    assert.notEqual(shown, text)
    assert.ok(shown.includes(TRIM_MARKER))
    assert.ok(shown.startsWith('[A-HEAD]'))
    assert.ok(shown.endsWith('[A-TAIL]'))
    assert.ok(shown.length < text.length)
  })

  it('leaves a within-budget result completely alone', async () => {
    const w = await world({ config: SMALL })
    const text = body(120, 'B')
    const session = w.session({ results: [{ text }] })
    await flush()
    assert.equal(surfaceTextOfSeq(session, lastResultSeq(session)), text)
    assert.equal(eventsOfType(session, 'tool/result').length, 1)
    assert.equal(eventsOfType(session, 'compaction/prune').length, 0)
    assert.equal(w.logs.matching('removed', 'info').length, 0)
  })

  it('leaves a result exactly at the threshold alone', async () => {
    const w = await world({ config: SMALL })
    const text = 'x'.repeat(SMALL.thresholdChars)
    const session = w.session({ results: [{ text }] })
    await flush()
    assert.equal(surfaceTextOfSeq(session, lastResultSeq(session)), text)
    assert.equal(eventsOfType(session, 'compaction/prune').length, 0)
  })

  it('bounds a result whose call event it never saw', async () => {
    const w = await world({ config: SMALL })
    const session = w.session()
    const callId = ToolCallId('call-orphan')
    // No preceding `tool/call`: the tool name is unknowable, and the promise is a
    // budget on every result — an unnamed result is not an exception.
    const text = body(600, 'ORPH')
    const event = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError: false }),
    }, { surfaceOp: 'append' })
    await flush()
    assert.ok(surfaceResultText(session, 'call-orphan').includes(TRIM_MARKER))
  })

  it('bounds several results in one pass', async () => {
    const w = await world({ config: SMALL })
    const session = w.session({ results: [{ text: body(600, 'C1') }, { text: body(700, 'C2') }] })
    await flush()
    assert.equal(eventsOfType(session, 'compaction/prune').length, 2)
    const shown = surfaceText(session)
    assert.ok(shown.includes('[C1-HEAD]') && shown.includes('[C1-TAIL]'))
    assert.ok(shown.includes('[C2-HEAD]') && shown.includes('[C2-TAIL]'))
  })

  it('replaces each result once, however often the queue is drained', async () => {
    const w = await world({ config: SMALL })
    const session = w.session({ results: [{ text: body(600, 'D') }] })
    await flush()
    await flush()
    await flush()
    assert.equal(eventsOfType(session, 'tool/result').length, 2)
    assert.equal(eventsOfType(session, 'compaction/prune').length, 1)
  })

  it('leaves a replacement another producer wrote alone, even when it is over budget', async () => {
    // The other half of "only an appended result carries new tool output": a
    // replacement is a producer's decision about a node that already exists —
    // the shipped pruner's, or another plugin's — and this plugin budgets results
    // at the moment they arrive rather than re-deciding someone else's reduction.
    //
    // The replacement here is deliberately still over budget, so "left alone" is
    // a behaviour this arm can falsify: without the guard the replacement would be
    // queued and a second pair written over it.
    const w = await world({ config: SMALL })
    const session = w.session({ id: 'budget-foreign-replace', results: [{ text: body(150, 'N') }] })
    const [original] = eventsOfType(session, 'tool/result')
    session.append('tool/result', {
      ...original.data,
      message: { ...original.data.message, content: [{ type: 'text', text: body(600, 'N') }] },
    }, {
      surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
      sourceEventSeqs: [original.seq],
    })

    await flush()

    assert.equal(eventsOfType(session, 'compaction/prune').length, 0)
    assert.equal(eventsOfType(session, 'tool/result').length, 2)
  })

  it('leaves a result whose weight is not text alone', async () => {
    const w = await world({ config: SMALL })
    const session = w.session({
      results: [{
        content: [{ type: 'image', attachment: { attachmentId: 'img', mediaType: 'image/png' } }],
      }],
    })
    await flush()
    assert.equal(eventsOfType(session, 'compaction/prune').length, 0)
    assert.equal(eventsOfType(session, 'tool/result').length, 1)
  })
})

describe('the exemption list', () => {
  it('leaves a named exempt tool alone', async () => {
    const w = await world({ config: { ...SMALL, exemptTools: ['read_file'] } })
    const session = w.session({ results: [{ name: 'read_file', text: body(600, 'EXEMPT') }] })
    await flush()
    assert.equal(eventsOfType(session, 'compaction/prune').length, 0)
    assert.equal(eventsOfType(session, 'tool/result').length, 1)
  })

  it('still bounds the tools that are not on the list', async () => {
    const w = await world({ config: { ...SMALL, exemptTools: ['read_file'] } })
    // A distinctive token in the middle, because the head and the tail of a
    // budgeted result are exactly what survives — asserting on either end would
    // be asserting that the reduction did nothing.
    const middle = 'the-middle-that-was-removed'
    const bodyOf = tag => `[${tag}]${'x'.repeat(300)}${middle}${'y'.repeat(300)}[${tag}-END]`
    const session = w.session({
      results: [
        { name: 'read_file', text: bodyOf('KEPT') },
        { name: 'bash', text: bodyOf('TRIM') },
      ],
    })
    await flush()
    assert.equal(eventsOfType(session, 'compaction/prune').length, 1)
    const kept = surfaceResultText(session, 'call-1')
    const trimmed = surfaceResultText(session, 'call-2')
    assert.ok(kept.includes(middle), 'the exempt tool keeps its middle')
    assert.ok(trimmed.includes(TRIM_MARKER))
    assert.ok(!trimmed.includes(middle), 'the budgeted tool loses its middle')
    assert.ok(trimmed.startsWith('[TRIM]'))
    assert.ok(trimmed.endsWith('[TRIM-END]'))
  })

  it('does not exempt a result whose tool name is unknown', async () => {
    // An exemption names a tool. A result with no observed call event has no
    // name to match, and treating that as exempt would be a hole any tool could
    // fall through by calling itself something new.
    const w = await world({ config: { ...SMALL, exemptTools: ['read_file'] } })
    const session = w.session()
    const text = body(600, 'ANON')
    const event = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: ToolCallId('c'), content: [{ type: 'text', text }], isError: false }),
    }, { surfaceOp: 'append' })
    await flush()
    assert.notEqual(event.seq, undefined)
    assert.ok(surfaceResultText(session, 'c').includes(TRIM_MARKER))
  })
})

describe('the moment of the write', () => {
  it('cannot append from inside the publication that delivered the event', async () => {
    // The mechanism the deferral exists for. A listener that appends from
    // `session/event` is writing inside `Session.append`'s publication, and the
    // session refuses it — the throw is contained and logged, which is why a
    // plugin that did this would silently bound nothing at all.
    const w = await world({ mounted: false })
    w.ctx.on('session/event', (session, event) => {
      if (event.type !== 'tool/result') return
      session.append('compaction/prune', {
        shadowedRange: { start: event.seq, end: event.seq },
        shadowedSeqs: [event.seq],
        shadowedTokenCount: 1,
      })
    })
    const session = w.session({ results: [{ text: 'x' }] })
    // The refusal is real and total: no shadow-price event landed, and the
    // session's log holds no replacement at all.
    assert.equal(eventsOfType(session, 'compaction/prune').length, 0)
    const refusals = w.logs.matching('cannot reenter', 'warn')
    assert.equal(refusals.length, 1)
    assert.ok(String(refusals[0].args[0]).includes('session/event listener threw'))
  })

  it('commits at the pre-step barrier without waiting for the microtask', async () => {
    const w = await world({ config: SMALL })
    const text = body(600, 'E')
    const session = w.session({ results: [{ text }] })
    assert.equal(surfaceResultText(session, 'call-1'), text)
    // No `flush()`: the barrier alone must have made the reduction before the
    // request that could carry it is assembled.
    await preStep(w.ctx, agentFor(session))
    assert.ok(surfaceResultText(session, 'call-1').includes(TRIM_MARKER))
  })

  it('runs before a listener that was already registered, so the pressure decision sees it', async () => {
    // The hazard is not a listener registered later — it is one registered
    // FIRST, which is the normal case: the shipped `compaction-basic` measures the
    // surface on this same waterfall and its plugin is mounted before a
    // third-party one appears. Ordinary waterfall order would put this plugin
    // last, so the arm registers an observer before mounting the plugin and reads
    // the surface exactly where `compaction-basic` reads it.
    const w = await world({ mounted: false })
    let observed
    w.ctx.on('agent/pre-step', (_payload, next) => {
      observed = w.meter.measure(session).totalTokens
      return next()
    })
    await w.ctx.plugin(plugin, SMALL)

    // Built after the mount, so the plugin is watching when the result arrives.
    const text = body(600, 'F')
    const session = w.session({ results: [{ text }] })
    const unbounded = w.meter.measure(session).totalTokens

    await preStep(w.ctx, agentFor(session))
    assert.notEqual(observed, undefined)
    assert.ok(observed < unbounded, `expected the barrier's reduction to be visible (${observed} vs ${unbounded})`)
  })

  it('does not attempt a write while no turn is open', async () => {
    // A surface replacement with no open turn leaves a log the format validator
    // refuses to read back. One unbounded result is a far cheaper outcome than a
    // session that cannot be loaded.
    const w = await world({ config: SMALL })
    const session = w.session()
    const text = body(600, 'G')
    const event = appendResult(session, { callId: 'call-closed', text })
    closeTurn(session)
    await flush()
    assert.equal(surfaceTextOfSeq(session, event.seq), text)
    assert.equal(eventsOfType(session, 'compaction/prune').length, 0)
  })
})

describe('session scope', () => {
  it('keeps each session\u2019s pending results to itself', async () => {
    const w = await world({ config: SMALL })
    const first = w.session({ id: 'budget-first', results: [{ text: body(600, 'H1') }] })
    const second = w.session({ id: 'budget-second', results: [{ text: body(600, 'H2') }] })
    await flush()
    for (const session of [first, second]) {
      assert.equal(eventsOfType(session, 'tool/result').length, 2)
      assert.equal(eventsOfType(session, 'compaction/prune').length, 1)
      // The replacement belongs to its own session: neither log mentions the
      // other's body.
      const shown = surfaceText(session)
      assert.ok(shown.includes(TRIM_MARKER))
    }
    assert.ok(!surfaceText(first).includes('[H2-HEAD]'))
    assert.ok(!surfaceText(second).includes('[H1-HEAD]'))
  })
})

describe('reporting', () => {
  it('reports the code points it removed and the session it removed them from', async () => {
    const w = await world({ config: SMALL })
    const session = w.session({ id: 'budget-report', results: [{ text: body(600, 'I') }] })
    await flush()
    const lines = w.logs.matching('removed', 'info')
    assert.equal(lines.length, 1)
    const line = String(lines[0].args[0])
    // 600 code points in, head + marker + tail out.
    const removed = 600 - (SMALL.headChars + TRIM_MARKER.length + SMALL.tailChars)
    assert.ok(line.includes('tool-output-budget:'))
    assert.ok(line.includes('budget-report'))
    assert.ok(line.includes(`removed ${removed} characters`))
    assert.ok(line.includes('1 result'))
    assert.ok(line.includes('remain in the session log'))
  })

  it('says nothing when it bounded nothing', async () => {
    const w = await world({ config: SMALL })
    w.session({ id: 'budget-quiet', results: [{ text: body(120, 'J') }] })
    await flush()
    assert.equal(w.logs.matching('removed', 'info').length, 0)
  })

  it('never warns about a write the session accepted', async () => {
    const w = await world({ config: SMALL })
    w.session({ id: 'budget-nowarn', results: [{ text: body(600, 'K') }] })
    await flush()
    assert.equal(w.logs.matching('tool-output-budget:', 'warn').length, 0)
  })
})

describe('mounting', () => {
  it('mounts from the module namespace as well as the default export', async () => {
    const w = await world({ form: 'namespace', config: SMALL })
    const session = w.session({ id: 'budget-namespace', results: [{ text: body(600, 'L') }] })
    await flush()
    assert.ok(surfaceTextOfSeq(session, lastResultSeq(session)).includes(TRIM_MARKER))
  })

  it('refuses to mount on a configuration it cannot honour', async () => {
    await assert.rejects(
      () => world({ config: { threshold: 10 } }),
      /unknown key "threshold"/u,
    )
  })

  it('watches a session it first saw mid-life, not only one it created', async () => {
    // A resume enters an existing session; the plugin reads no past events, so
    // the arm is that it still bounds everything appended from then on.
    const w = await world({ config: SMALL })
    const session = w.session({ id: 'budget-resumed' })
    assert.equal(w.logs.matching('removed', 'info').length, 0)
    appendResult(session, { callId: 'call-late', text: body(600, 'M') })
    await flush()
    assert.equal(eventsOfType(session, 'compaction/prune').length, 1)
  })
})
