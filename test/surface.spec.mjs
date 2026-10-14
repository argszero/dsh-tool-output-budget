/**
 * The durable protocol the plugin writes: what the log keeps, what the surface
 * changes, and what the token meter is told.
 *
 * These arms are the ones that would catch a wrong *shape* rather than a wrong
 * decision — a reduction that lost the tool's real output, a replacement that
 * changed a field it may not, a claim that priced something other than the node
 * it shadows. The shipped `surface.ts` predicates enforce most of this at append
 * time, so a suite that only ran the behaviour arms would pass while the write
 * was refused and the behaviour silently became "nothing happened".
 *
 * @module test/surface.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TRIM_MARKER, measureContent, planTrim, resolveConfig, trimContent } from '../lib/index.js'
import {
  appendResult,
  body,
  eventsOfType,
  flush,
  surfaceResultText,
  surfaceSeqs,
  surfaceTextOfSeq,
  world,
} from './harness.mjs'

/** A budget that a `body(600)` result is comfortably over. */
const SMALL = { thresholdChars: 200, headChars: 40, tailChars: 20 }

/**
 * A message projection of the shape a real one has: a durable decision event
 * naming surface nodes whose derived message it replaces.
 *
 * `image/offload` is the shipped instance of this shape. A fixture is used
 * instead of that plugin because what is under test is the *price* the plugin
 * states, not image handling: this projection makes the difference measurable
 * with one line.
 */
const REWRITE_PROJECTION = {
  type: 'fixture/rewrite',
  project(event) {
    const messages = new Map()
    for (const target of event.data.targets) messages.set(target.seq, target.message)
    return messages
  },
}

/**
 * The message a `fixture/rewrite` target carries.
 *
 * Two differences on purpose: the text the model would be sent is short, and a
 * field other than `content` is changed. The first is what makes the price arm
 * discriminating; the second is what a plugin-owned projection is allowed to do,
 * and therefore what makes the "build the replacement from the logged message"
 * rule observable — `Session.append` refuses a `tool/result` replacement whose
 * data differs from its shadowed node in any field but `message.content`.
 */
function rewriteOf(message) {
  return { ...message, content: [{ type: 'text', text: 'PROJECTED' }], isError: true }
}

describe('the committed pair', () => {
  it('keeps the tool\u2019s real output in the durable log', async () => {
    const w = await world({ config: SMALL })
    const text = body(600, 'LOG')
    const session = w.session({ results: [{ text }] })
    const originalSeq = eventsOfType(session, 'tool/result')[0].seq

    await flush()

    // oxlint-disable-next-line typescript/no-deprecated -- surface positions are current log indices.
    const original = session.eventAt(originalSeq)
    assert.equal(original.type, 'tool/result')
    assert.equal(original.data.message.content[0].text, text)
    // And the surface really did move, or this arm would pass on a plugin that
    // did nothing at all.
    assert.ok(surfaceResultText(session, 'call-1').includes(TRIM_MARKER))
  })

  it('writes exactly one claim and one replacement', async () => {
    const w = await world({ config: SMALL })
    const session = w.session({ results: [{ text: body(600, 'PAIR') }] })
    await flush()
    assert.equal(eventsOfType(session, 'compaction/prune').length, 1)
    assert.equal(eventsOfType(session, 'tool/result').length, 2)
  })

  it('appends the claim and its replacement adjacently, claim first', async () => {
    // Adjacency is a property of the protocol, not a nicety: the meter's fold
    // consumes a claim on the very next event, so any event between the two
    // would expire it and the replacement would fold with a zero delta.
    const w = await world({ config: SMALL })
    const session = w.session({ results: [{ text: body(600, 'ADJ') }] })
    await flush()
    const [prune] = eventsOfType(session, 'compaction/prune')
    const replacement = eventsOfType(session, 'tool/result')[1]
    assert.equal(replacement.seq, prune.seq + 1)
    assert.deepEqual(session.snapshotEvents().slice(prune.seq, replacement.seq + 1).map(event => event.type), [
      'compaction/prune',
      'tool/result',
    ])
  })

  it('names the shadowed node and the claim in sourceEventSeqs', async () => {
    const w = await world({ config: SMALL })
    const session = w.session({ results: [{ text: body(600, 'SRC') }] })
    const originalSeq = eventsOfType(session, 'tool/result')[0].seq
    await flush()
    const [prune] = eventsOfType(session, 'compaction/prune')
    const replacement = eventsOfType(session, 'tool/result')[1]
    assert.deepEqual(replacement.sourceEventSeqs, [prune.seq, originalSeq])
    assert.deepEqual(prune.data.shadowedSeqs, [originalSeq])
    assert.deepEqual(prune.data.shadowedRange, { start: originalSeq, end: originalSeq })
  })

  it('prices the shadowed node with the meter\u2019s own estimate of that node', async () => {
    const w = await world({ config: SMALL })
    const session = w.session({ results: [{ text: body(600, 'PRICE') }] })
    const originalSeq = eventsOfType(session, 'tool/result')[0].seq
    await flush()
    // oxlint-disable-next-line typescript/no-deprecated -- surface positions are current log indices.
    const originalMessage = session.eventAt(originalSeq).data.message
    const [prune] = eventsOfType(session, 'compaction/prune')
    assert.equal(prune.data.shadowedTokenCount, w.meter.estimateMessage(originalMessage))
  })

  it('prices the message the model is sent, not the text the tool logged', async () => {
    // A plugin-owned message projection can rewrite the message an
    // already-appended node derives to without taking the node off the surface —
    // which is exactly what the shipped `image/offload` projection does to a tool
    // result. The claim has to be the price of *that* message: the shipped
    // producer (`compaction-tool-result-pruner`) reads the node through
    // `deriveEventMessage` for both, and a consumer subtracts one from the other.
    //
    // The fixture first proves it can make the two prices differ, so "priced the
    // derived message" is a claim this arm can falsify rather than one the
    // logged and derived messages happen to satisfy together.
    const w = await world({ config: SMALL })
    await w.store.registerMessageProjection(REWRITE_PROJECTION)
    const session = w.session({ id: 'budget-projected', results: [{ text: body(600, 'PROJ') }] })
    const [original] = eventsOfType(session, 'tool/result')
    session.append('fixture/rewrite', {
      targets: [{ seq: original.seq, message: rewriteOf(original.data.message) }],
    })
    const derived = session.deriveEventMessage(original)
    assert.notEqual(
      w.meter.estimateMessage(derived),
      w.meter.estimateMessage(original.data.message),
      'the fixture must make the logged and derived prices differ, or this arm proves nothing',
    )

    await flush()

    const [prune] = eventsOfType(session, 'compaction/prune')
    assert.equal(prune.data.shadowedTokenCount, w.meter.estimateMessage(derived))
  })

  it('still bounds a result whose projection rewrites a field the replacement may not', async () => {
    // The counterpart of the price arm: the same projection, read from the other
    // side. The node's *derived* message says `isError: true` while the durable
    // event says `false`, so a replacement assembled from the projected message
    // would be refused by `Session.append` — and the budget would silently stop
    // applying to exactly the results a plugin had already decided to rewrite.
    const w = await world({ config: SMALL })
    await w.store.registerMessageProjection(REWRITE_PROJECTION)
    const session = w.session({ id: 'budget-reflagged', results: [{ text: body(600, 'FLAG') }] })
    const [original] = eventsOfType(session, 'tool/result')
    session.append('fixture/rewrite', {
      targets: [{ seq: original.seq, message: rewriteOf(original.data.message) }],
    })
    assert.equal(session.deriveEventMessage(original).isError, true)
    assert.equal(original.data.message.isError, false)

    await flush()

    assert.equal(eventsOfType(session, 'compaction/prune').length, 1)
    assert.ok(surfaceResultText(session, 'call-1').includes(TRIM_MARKER))
    // And the replacement it wrote is the logged message's shape, not the
    // projected one's: the field the projection changed is not carried over.
    const replacement = eventsOfType(session, 'tool/result')[1]
    assert.equal(replacement.data.message.isError, false)
    assert.equal(w.logs.matching('tool-output-budget:', 'warn').length, 0)
  })

  it('changes only the content of the node it shadows', async () => {
    const w = await world({ config: SMALL })
    const session = w.session({ results: [{ text: body(600, 'ONLY') }] })
    await flush()
    const [original, replacement] = eventsOfType(session, 'tool/result')
    const restWithContent = event => {
      const message = { ...event.data.message }
      delete message.content
      return { ...event.data, message }
    }
    assert.deepEqual(restWithContent(replacement), restWithContent(original))
    // And the content is genuinely different, so "changes only content" is not
    // satisfied by changing nothing.
    assert.notDeepEqual(replacement.data.message.content, original.data.message.content)
  })

  it('leaves the replacement content exactly what the pure reducer produced', async () => {
    const w = await world({ config: SMALL })
    const text = body(600, 'PURE')
    const session = w.session({ results: [{ text }] })
    const [original] = eventsOfType(session, 'tool/result')
    await flush()
    const replacement = eventsOfType(session, 'tool/result')[1]
    const expected = trimContent([{ type: 'text', text }], resolveConfig(SMALL))
    assert.notEqual(expected, null)
    assert.deepEqual(replacement.data.message.content, expected)
    assert.equal(measureContent(original.data.message.content), 600)
  })
})

describe('the surface after the write', () => {
  it('shows one result, at the position the original occupied', async () => {
    const w = await world({ config: SMALL })
    // The second result is deliberately inside the budget: it stands for every
    // ordinary result, and it is what proves the replacement landed *in place*
    // rather than at the end of the surface.
    const session = w.session({ results: [{ text: body(600, 'POS') }, { text: 'NEXT (within budget)' }] })
    const before = surfaceSeqs(session)
    const originalSeq = eventsOfType(session, 'tool/result')[0].seq
    const index = before.indexOf(originalSeq)

    await flush()

    const after = surfaceSeqs(session)
    assert.equal(after.includes(originalSeq), false)
    assert.equal(after.length, before.length)
    const replacement = eventsOfType(session, 'tool/result')[2]
    assert.equal(after[index], replacement.seq)
    // The whole surface, not just the one position: replacing a node must leave
    // every other node exactly where it was, or a request built from this surface
    // would read the conversation out of order. The second result — appended after
    // the trimmed one — is right where it always was.
    const expected = [...before]
    expected[index] = replacement.seq
    assert.deepEqual(after, expected)
    const secondSeq = eventsOfType(session, 'tool/result')[1].seq
    assert.equal(after.indexOf(secondSeq), before.indexOf(secondSeq))
    assert.ok(after.indexOf(secondSeq) > index)
  })

  it('prices the reduced surface at exactly what a request built from it would cost', async () => {
    // The identity that makes "the request got smaller" a measurement rather
    // than a hope: the live session folds to the same total as a session whose
    // result carries the reduced text from the start.
    const w = await world({ config: SMALL })
    const text = body(600, 'ID')
    const session = w.session({ results: [{ text }] })
    const before = w.meter.measure(session).totalTokens

    await flush()

    const reduced = surfaceResultText(session, 'call-1')
    const control = await world({ mounted: false })
    const plain = control.session({ id: 'control', results: [{ text: reduced }] })
    assert.equal(w.meter.measure(session).totalTokens, control.meter.measure(plain).totalTokens)
    assert.ok(w.meter.measure(session).totalTokens < before)
  })

  it('reads back out of the durable log into the same surface', async () => {
    // The whole reason the write goes through the surface rather than through
    // the recorded result: a session whose log holds this pair must still load.
    const w = await world({ config: SMALL })
    const session = w.session({ id: 'budget-replay', results: [{ text: body(600, 'REPLAY') }] })
    await flush()

    const replay = w.store.create(SessionId('budget-replay-copy'), { seed: session.snapshotEvents() })
    assert.deepEqual(surfaceSeqs(replay), surfaceSeqs(session))
    assert.equal(surfaceTextOfSeq(replay, surfaceSeqs(replay)[3]), surfaceResultText(session, 'call-1'))
    assert.ok(surfaceResultText(replay, 'call-1').includes(TRIM_MARKER))
  })
})

describe('the laws the write obeys', () => {
  it('is refused by the session when more than the content changes', async () => {
    // The reason `commitTrim` builds the replacement from the *logged* message:
    // a plugin-owned message projection can rewrite other fields, and a
    // replacement built from the projected message would be refused here.
    const w = await world({ mounted: false })
    const session = w.session({ results: [{ text: body(600, 'LAW') }] })
    const [original] = eventsOfType(session, 'tool/result')
    const message = freezeMessage({ ...original.data.message, content: [{ type: 'text', text: 'reduced' }] })
    assert.throws(
      () => session.append('tool/result', { ...original.data, turn: 99, message }, {
        surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
        sourceEventSeqs: [original.seq],
      }),
      /may change only content/u,
    )
  })

  it('is refused by the session when no shadowed node is named', async () => {
    const w = await world({ mounted: false })
    const session = w.session({ results: [{ text: body(600, 'MISS') }] })
    const [original] = eventsOfType(session, 'tool/result')
    const message = freezeMessage({ ...original.data.message, content: [{ type: 'text', text: 'reduced' }] })
    assert.throws(
      () => session.append('tool/result', { ...original.data, message }, {
        surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
      }),
      /must include every shadowed surface node/u,
    )
  })

  it('refuses to plan a trim for a node that left the surface', async () => {
    // `planTrim` is callable on its own, and its one refusal is the condition
    // under which the pair would be rejected: the node is no longer there to
    // shadow. Deciding *then* would append a claim pricing a range it does not
    // own.
    const w = await world({ config: SMALL })
    const session = w.session({ results: [{ text: body(600, 'STALE') }] })
    const [original] = eventsOfType(session, 'tool/result')
    await flush()
    assert.throws(
      () => planTrim(session, w.meter, resolveConfig(SMALL), {
        seq: original.seq,
        event: original,
        toolName: 'bash',
      }),
      /is no longer on the surface/u,
    )
  })

  it('does not write at all when the result is within budget', async () => {
    const w = await world({ config: SMALL })
    const text = body(120, 'NOOP')
    const session = w.session({ results: [{ text }] })
    const [original] = eventsOfType(session, 'tool/result')
    await flush()
    assert.equal(planTrim(session, w.meter, resolveConfig(SMALL), {
      seq: original.seq,
      event: original,
      toolName: 'bash',
    }), null)
    assert.equal(eventsOfType(session, 'compaction/prune').length, 0)
  })

  it('appends the pair such that a further result still lands normally', async () => {
    // Two trims in one session must not leave the surface in a state where the
    // next claim cannot be consumed: the second pair is written the same way the
    // first was, and both are adjacent.
    const w = await world({ config: SMALL })
    const session = w.session({ results: [{ text: body(600, 'FIRST') }] })
    await flush()
    appendResult(session, { callId: 'call-second', text: body(600, 'SECOND') })
    await flush()
    const prunes = eventsOfType(session, 'compaction/prune')
    assert.equal(prunes.length, 2)
    const results = eventsOfType(session, 'tool/result')
    assert.equal(results.length, 4)
    assert.equal(results[1].seq, prunes[0].seq + 1)
    assert.equal(results[3].seq, prunes[1].seq + 1)
    assert.ok(surfaceResultText(session, 'call-second').includes(TRIM_MARKER))
  })
})
