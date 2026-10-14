/**
 * The harness: a REAL cordis context carrying the REAL services this plugin
 * depends on (`TokenMeter` and its required `SessionProjectionRegistry`, plus
 * `LlmRuntime` so the meter has a route to price under), REAL
 * `@deepseek-ai/dsh-session` sessions built through the shipped
 * `SessionStore.create` path, and the REAL `agent/pre-step` waterfall dispatched
 * through `agentEvents(ctx, agent)` — the same fused dispatcher the agent loop
 * calls.
 *
 * Four things are deliberately not simulated:
 *
 * - **The publication path.** Fixtures are built with `store.create(...)` and
 *   then appended to, so every `tool/result` is published as `session/event`
 *   exactly as the runtime publishes it. A session built by bare
 *   `Session.create` is attached to no context and publishes nothing, so an arm
 *   about what this plugin *hears* would be an arm about nothing.
 * - **The trigger.** `preStep()` goes through `agentEvents`, so scope filtering,
 *   `{ prepend: true }` ordering and the waterfall's value passing are the
 *   shipped ones.
 * - **The surface fold.** Every append the plugin makes is validated by the
 *   shipped `surface.ts` predicates, so a replacement that omitted a shadowed
 *   node, named no source, or changed a field other than `content` throws here
 *   exactly as it would in production.
 * - **The prices.** `TokenMeter` is the shipped service, so "the replacement is
 *   smaller than the shadowed node" is decided by the same estimator the engine
 *   uses, and `meter.measure` folds the shadow-price pair the way the pressure
 *   estimate does.
 *
 * `world({ mounted: false })` is the control arm for every "the plugin bounded
 * this" claim: the same context, the same fixture, the same events, with nothing
 * mounted.
 *
 * @module test/harness
 */

import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import {
  LlmAdapter,
  LlmRuntime,
  ToolCallId,
  createMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import plugin, * as namespace from '../lib/index.js'

/** The module namespace, for the arm that asserts both export forms mount. */
export { namespace }

/** The model every fixture routes through. */
export const MODEL = 'harness-model'

/** A fresh, never-aborted turn signal. */
export function signal() {
  return new AbortController().signal
}

/**
 * Collect every structured log record this process publishes.
 *
 * `levels` is not decoration: an exporter that declares none falls back to
 * `LoggerLevel.INFO` as its threshold, and `info` is *above* the default
 * threshold's floor in this build, so a capture registered without them silently
 * drops exactly the records these arms assert on.
 */
export function captureLogs(ctx) {
  const records = []
  ctx.logger.exporter({ colors: false, levels: { default: 3 }, export: message => records.push(message) })
  return {
    records,
    /** Every captured record of one severity whose format string contains `needle`. */
    matching(needle, type = 'info') {
      return records.filter(record => record.type === type && String(record.args[0]).includes(needle))
    },
  }
}

/** An adapter that only has to answer `resolveModel`, so the meter prices the fixture. */
class HarnessAdapter extends LlmAdapter {
  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 1_000_000 },
    })
  }

  // eslint-disable-next-line require-yield -- the terminal frame is the whole stream.
  async * stream() {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Build one world.
 * @param world.mounted - `false` mounts nothing, which is the control arm.
 * @param world.config - the plugin configuration to mount with.
 * @param world.form - which export to mount: the `default` (what a Loader entry
 *   resolves) or the module `namespace`.
 * @returns the context, the log capture, the store, and the dispatch entry.
 */
export async function world({ mounted = true, config = {}, form = 'default' } = {}) {
  const ctx = new Context()
  const logs = captureLogs(ctx)
  void new LlmRuntime(ctx)
  // The registry is a required injection of TokenMeter (its projection units
  // register in the constructor); mount it synchronously.
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  const store = new SessionStore(ctx)
  ctx.llm.registerAdapter([MODEL], new HarnessAdapter())

  if (mounted) await ctx.plugin(form === 'namespace' ? namespace : plugin, config)

  return {
    ctx,
    logs,
    store,
    meter: ctx.tokenMeter,
    /** Build a fixture into this world's store, so its appends are published. */
    session: options => budgetSession(store, options),
    /** Dispatch one `agent/pre-step`, exactly as the loop does. */
    preStep: (agent, position) => preStep(ctx, agent, position),
  }
}

/** The `Agent` shell a pre-step is dispatched against; only `session` and `options` are read. */
export function agentFor(session) {
  return { session, options: {}, status: 'idle' }
}

/**
 * Dispatch one `agent/pre-step`, exactly as the loop does.
 *
 * The terminal is the loop's own shape: `agent-loop/src/agent.ts` passes a
 * `{ kind: 'enter' }` decision built from the assembled context, and the loop
 * enters the step unless the composed decision is `{ kind: 'reject' }`.
 * @param ctx - the world's context.
 * @param agent - the agent whose step is being proposed.
 * @param options.turn - the turn that will own the step.
 * @param options.step - the step number.
 * @returns the decision the waterfall composed.
 */
export async function preStep(ctx, agent, { turn = 1, step = 2 } = {}) {
  return await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn, step, signal: signal() },
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
}

/**
 * Let every queued microtask run.
 *
 * The plugin defers its append by one microtask, so an arm that appended a
 * result and read the surface immediately would measure the state before the
 * drain. A macrotask boundary is used rather than a bare `await` because the
 * drain may itself queue further work.
 */
export function flush() {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

/** One `request/header` for the fixture's route, so the meter has an envelope to price under. */
function appendHeader(session) {
  session.append('request/header', {
    header: { config: { provider: MODEL, model: MODEL } },
    reason: 'initial',
  })
}

/**
 * A turn left OPEN, carrying `results` tool results.
 *
 * The turn is open because a surface replacement that lands in no open turn
 * leaves a log the format validator refuses to read back — the plugin's
 * `no-open-turn` guard exists precisely to keep that from being attempted, and an
 * arm proving the guard does nothing has to be built on the same shape.
 * @param store - the world's session store; the fixture is created through it so
 *   its appends are published.
 * @param options.id - session id.
 * @param options.results - one entry per appended tool call/result pair:
 *   `{ text }`, or `{ content }` for a richer block list, or `{ name }` to
 *   attribute the call to a named tool.
 * @param options.turn - the turn number.
 * @param options.step - the step number.
 * @returns the live session.
 */
export function budgetSession(store, {
  id = 'tool-output-budget',
  results = [],
  turn = 1,
  step = 1,
} = {}) {
  const session = store.create(SessionId(id))
  session.append('turn/start', { turn })
  session.append('system/message', {
    turn,
    step: 1,
    message: createSystemMessage('You are a harness fixture.'),
  }, { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'run the tools' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step })
  appendHeader(session)
  for (const [index, result] of results.entries()) {
    const callId = ToolCallId(result.callId ?? `call-${index + 1}`)
    const name = result.name ?? 'bash'
    session.append('assistant/message', {
      stream: [],
      turn,
      step,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step, callId, name, arguments: '{}' })
    session.append('tool/result', {
      turn,
      step,
      message: createToolResultMessage({
        callId,
        content: result.content ?? [{ type: 'text', text: result.text ?? '' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
  }
  return session
}

/**
 * Append one more tool call/result to an already-open turn.
 *
 * This is the shape of the defect's most common occurrence: a step finishes a
 * tool call, the result arrives, and the loop proposes its next step.
 * @param session - the open session.
 * @param options.turn - the turn number.
 * @param options.step - the step number.
 * @param options.callId - the provider-issued call id.
 * @param options.name - the tool name.
 * @param options.content - the result's content blocks.
 * @param options.text - shorthand for a single text block.
 * @returns the appended `tool/result` event.
 */
export function appendResult(session, {
  turn = 1,
  step = 1,
  callId = 'call-next',
  name = 'bash',
  content,
  text,
} = {}) {
  const id = ToolCallId(callId)
  session.append('assistant/message', {
    stream: [],
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id, name, arguments: '{}' }],
      source: { kind: 'model', provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step, callId: id, name, arguments: '{}' })
  return session.append('tool/result', {
    turn,
    step,
    message: createToolResultMessage({
      callId: id,
      content: content ?? [{ type: 'text', text: text ?? '' }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
}

/** Close an open turn the way the loop does. */
export function closeTurn(session, turn = 1) {
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Every surface node seq, in model-visible order. */
export function surfaceSeqs(session) {
  return [...session.surface.nodes]
}

/** Every durable event of one type, in log order. */
export function eventsOfType(session, type) {
  return session.snapshotEvents().filter(event => event.type === type)
}

/** The message the surface currently shows at one position. */
export function surfaceMessageAt(session, index) {
  const seq = session.surface.nodes[index]
  if (seq === undefined) return undefined
  // oxlint-disable-next-line typescript/no-deprecated -- surface positions are current log indices.
  const event = session.eventAt(seq)
  return event === undefined ? undefined : session.deriveEventMessage(event) ?? undefined
}

/** The joined text of one surface message. */
export function textOf(message) {
  if (message === undefined) return ''
  return message.content.map(block => block.text ?? '').join('')
}

/**
 * The joined text of every model-visible message on the surface.
 *
 * This is the quantity the defect is about: what the next request would carry.
 * @param session - the session to read.
 * @returns the concatenated text of the current surface.
 */
export function surfaceText(session) {
  let text = ''
  for (let index = 0; index < session.surface.nodes.length; index += 1) {
    text += `${textOf(surfaceMessageAt(session, index))}\n`
  }
  return text
}

/**
 * The model-visible text of one tool result, by its original log seq.
 *
 * Returns `''` once the node is no longer on the surface at all — which is
 * exactly what a landed replacement does to the node it shadowed — so an arm
 * about "what the model now reads for this call" wants
 * {@link surfaceResultText} instead.
 * @param session - the session to read.
 * @param seq - the original `tool/result` seq.
 * @returns its text as the current surface shows it, or `''`.
 */
export function surfaceTextOfSeq(session, seq) {
  const index = session.surface.nodes.indexOf(seq)
  if (index === -1) return ''
  return textOf(surfaceMessageAt(session, index))
}

/**
 * The model-visible text of the result answering one call, wherever it now sits.
 *
 * Keyed by call id rather than seq because a surface replacement moves the
 * result: after the plugin's write, the seq it read the event at is off the
 * surface and the call id is the only handle that still names the result.
 * @param session - the session to read.
 * @param callId - the provider-issued call id, as a string.
 * @returns the text of the surface message answering it, or `''` when the
 *   surface holds none.
 */
export function surfaceResultText(session, callId) {
  for (let index = 0; index < session.surface.nodes.length; index += 1) {
    const message = surfaceMessageAt(session, index)
    if (message?.role === 'tool' && message.toolCallId === callId) return textOf(message)
  }
  return ''
}

/**
 * How many results the surface shows for one call id.
 *
 * A surface replacement shadows its node rather than appending beside it, so a
 * hole in this count would mean the replacement left two copies of one result.
 * @param session - the session to read.
 * @param callId - the provider-issued call id, as a string.
 * @returns the number of surface messages answering it.
 */
export function surfaceResultCount(session, callId) {
  let count = 0
  for (let index = 0; index < session.surface.nodes.length; index += 1) {
    const message = surfaceMessageAt(session, index)
    if (message?.role === 'tool' && message.toolCallId === callId) count += 1
  }
  return count
}

/**
 * A deterministic body of exactly `chars` Unicode code points.
 * @param chars - how many code points to produce; must be at least 32.
 * @param seed - a marker carried at the head and the tail, so an arm can prove
 *   which end survived.
 * @returns the text.
 */
export function body(chars, seed = 'BODY') {
  const head = `[${seed}-HEAD]`
  const tail = `[${seed}-TAIL]`
  if (head.length + tail.length > chars) {
    throw new Error(`harness: body(${chars}) is too short to carry both markers`)
  }
  const filler = '0123456789abcdefghij'
  const middle = Math.max(0, chars - head.length - tail.length)
  return head + filler.repeat(Math.ceil(middle / filler.length)).slice(0, middle) + tail
}
