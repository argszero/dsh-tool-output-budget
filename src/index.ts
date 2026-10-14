/**
 * An unconditional, per-result budget on the tool output a model is asked to
 * read.
 *
 * ## The defect
 *
 * A tool result enters the model's history exactly as the tool printed it. One
 * `bash` command that prints a 3 MB build log, one `read_file` of a generated
 * bundle, one `grep -r` over a vendored tree — each becomes a permanent part of
 * every later request that session sends, and each is charged again on every
 * turn. The report behind this plugin (discussion #9583) measured a **53:1
 * ratio of context replayed to output produced** across a 21-subagent run:
 * 108,842,852 tokens and ¥46.94 spent, with an average of 36,454 tokens replayed
 * per request against 686 tokens produced.
 *
 * The harness does ship a reducer for exactly this content —
 * `@deepseek-ai/dsh-compaction-tool-result-pruner`, which keeps the head and the
 * tail of an over-long tool result and drops the middle — but it is **gated on
 * compaction pressure** ("below-pressure conversations remain unchanged", its
 * own README). The gap is therefore *before* the pressure: twenty oversized
 * results are replayed for twenty turns, and the two-billion-token run happens,
 * in the interval during which the session is not yet anywhere near its context
 * limit.
 *
 * ## What this plugin does
 *
 * It listens to `session/event`, notices each `tool/result` as it is appended,
 * and — once the step's synchronous work has finished — replaces the ones that
 * exceed a text budget with the head, a marker and the tail of the same result.
 * It is the shipped reducer's operation, performed at injection time instead of
 * under pressure, with a deliberately looser default budget (16 KiB rather than
 * 8 KiB) because it runs on every ordinary request rather than only when the
 * session is already in trouble.
 *
 * It keeps every tool — there is no allow-list to fall off, and an operator's
 * `exemptTools` is the escape hatch — and it bounds *text*: a result whose weight
 * is in image or resource blocks is left alone.
 *
 * ## Where it happens, and why that matters
 *
 * The result is **not** rewritten as it is recorded. `tools/post-execute` could
 * do that, and it would be simpler — but it would write the reduced text into the
 * durable log, and the tool's real output would then exist nowhere, for the user
 * reading the conversation no less than for a replay. This plugin writes the
 * other shape the harness already defines for exactly this: a `compaction/prune`
 * shadow price followed by a `tool/result` carrying
 * `surfaceOp: { op: 'replace' }`. The log keeps the original; only the surface —
 * the single source of the model's history — changes.
 *
 * `commit.ts` owns that pair and explains why the two appends cannot be split.
 * `trim.ts` owns the reduction. This module owns only the trigger.
 *
 * ## The trigger is deferred, and it has to be
 *
 * `Session.append` refuses a reentrant append ("session append cannot reenter
 * while another append is being published"), and a `session/event` listener runs
 * *inside* that publication. A plugin that appends from the listener therefore
 * throws on its first tool result — so the append is queued and drained from a
 * microtask, which runs as soon as the appending call stack has unwound. A
 * second drain runs at `agent/pre-step`: the microtask keeps the surface tight at
 * all times, and the barrier makes "committed before the request that could carry
 * it" a property of the code rather than of scheduling luck.
 *
 * ## What it does not do
 *
 * It does not summarize, does not call a model, does not refuse a tool call, and
 * does not touch history it did not watch arrive. A session resumed with
 * pre-existing oversized results keeps them — the plugin reads no past events at
 * all, which is the same decision that keeps it off the deprecated synchronous
 * read path. Mounting it on a long-running session bounds everything from that
 * point on.
 *
 * @module @argszero/dsh-tool-output-budget
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
// Type-only: the `agent/pre-step` Context merge this plugin listens on.
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: the `compaction/*` SessionEventMap merge (the shadow-price event).
import type {} from '@deepseek-ai/dsh-compaction'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-token-meter'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { commitTrim, planTrim } from './commit.ts'
import type { PendingResult } from './commit.ts'
import { resolveConfig } from './config.ts'
import type { Config, ResolvedConfig, SkippedEntry, TrimmedEntry, TrimResult } from './types.ts'

export { codePointLength, DEFAULTS, resolveConfig, TRIM_MARKER } from './config.ts'
export { measureContent, trimContent } from './trim.ts'
export { commitTrim, planTrim } from './commit.ts'
export type { PendingResult, TrimPlan } from './commit.ts'
export type { Config, ResolvedConfig, SkippedEntry, TrimmedEntry, TrimResult } from './types.ts'

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'tool-output-budget'

/**
 * The one service this plugin needs: the meter that prices the shadow claim.
 *
 * The claim must state exactly what the meter itself charged the shadowed node,
 * and the meter is the only thing that knows — so a session without it cannot
 * have its surface replaced *correctly*, and the dependency is required rather
 * than probed. `@deepseek-ai/dsh-token-meter` is in the base bundle of every
 * shipped profile.
 */
export const inject: readonly string[] = ['tokenMeter']

/** The prefix of every diagnostic this plugin logs. */
const LOG_PREFIX = 'tool-output-budget:'

/** Per-session observation state; dropped with the session. */
interface SessionState {
  /** Results observed and not yet decided. */
  readonly pending: PendingResult[]
  /** Whether a microtask drain is already scheduled for this session. */
  queued: boolean
  /** Whether a turn is open, so a replacement may legally be appended. */
  turnOpen: boolean
  /** Call ids of in-flight tool calls, for the exemption list. Bounded by in-flight calls. */
  readonly toolNames: Map<string, string>
}

/** An empty result, returned when a drain found nothing to do. */
const NOTHING: TrimResult = Object.freeze({
  trimmed: Object.freeze([]) as readonly TrimmedEntry[],
  skipped: Object.freeze([]) as readonly SkippedEntry[],
  charsRemoved: 0,
})

/**
 * Install the plugin.
 * @param ctx - the plugin context; both listeners are disposed with it.
 * @param config - the configuration as mounted, possibly empty. Defaults are
 *   applied here rather than in an exported `Config` object, because a plain
 *   object under that name is read as a schema by the Loader and makes the
 *   plugin unmountable.
 * @throws when the configuration names an unknown key or an unusable budget;
 *   the plugin refuses to mount rather than policing requests with a budget it
 *   cannot honour.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = resolveConfig(config)
  const sessions = new WeakMap<Session, SessionState>()

  const stateOf = (session: Session): SessionState => {
    let state = sessions.get(session)
    if (state === undefined) {
      // A session whose turn/start was never delivered — a resume happens between
      // turns, and the load does not re-publish history — is treated as closed. A
      // replacement appended with no open turn leaves the log valid to append and
      // invalid to read back, and refusing to guess costs one unbounded result.
      state = { pending: [], queued: false, turnOpen: false, toolNames: new Map() }
      sessions.set(session, state)
    }
    return state
  }

  ctx.on('session/event', (session, event) => {
    const state = stateOf(session)
    observe(state, event)
    if (state.pending.length === 0 || state.queued) return
    state.queued = true
    queueMicrotask(() => {
      state.queued = false
      drain(ctx, session, state, settings)
    })
  })

  // Prepended on purpose: the shipped pressure decision — `compaction-basic`
  // measures the surface on this same waterfall and summarizes when the estimate
  // crosses a threshold — must see the reduced surface, or this plugin would
  // hand the session to an expensive summarization to fix exactly the weight it
  // had already removed.
  ctx.on('agent/pre-step', ({ agent }, next): Promise<PreStepDecision> => {
    const state = stateOf(agent.session)
    if (state.pending.length > 0) drain(ctx, agent.session, state, settings)
    return next()
  }, { prepend: true })
}

/**
 * Route one committed event into one session's observation state.
 *
 * Nothing is appended here, and nothing may be: this runs inside the append that
 * published the event.
 * @param state - the session's observation state.
 * @param event - the committed event.
 */
function observe(state: SessionState, event: SessionEvent): void {
  switch (event.type) {
    case 'turn/start':
      state.turnOpen = true
      return
    case 'turn/end':
      state.turnOpen = false
      return
    case 'tool/call':
      state.toolNames.set(event.data.callId, event.data.name)
      return
    case 'tool/result': {
      // A replacement — this plugin's own or the compaction pruner's — is not a
      // result to inspect. Only an appended result carries new tool output.
      if (event.surfaceOp !== 'append') return
      const callId = event.data.message.toolCallId
      state.pending.push({ seq: event.seq, event, toolName: state.toolNames.get(callId) })
      // Exact and bounded: a call's name is needed only until its result arrives.
      state.toolNames.delete(callId)
      return
    }
    /* v8 ignore next 2 -- every other event type is outside this plugin's interest. */
    default:
      return
  }
}

/**
 * Decide and commit every pending result.
 *
 * A drain never throws into its caller: the append path is the session's, and a
 * plugin that broke a turn by failing to make a request smaller would be a worse
 * trade than an unbounded result. A refused write is reported and the remaining
 * results are still considered.
 * @param ctx - the plugin context, for logging.
 * @param session - the session whose surface is being bounded.
 * @param state - that session's observation state.
 * @param settings - resolved budgets.
 * @returns what this drain changed.
 */
function drain(
  ctx: Context,
  session: Session,
  state: SessionState,
  settings: ResolvedConfig,
): TrimResult {
  const queue = state.pending.splice(0, state.pending.length)
  if (queue.length === 0) return NOTHING

  const trimmed: TrimmedEntry[] = []
  const skipped: SkippedEntry[] = []
  let charsRemoved = 0

  for (const pending of queue) {
    const refusal = refuse(session, state, settings, pending)
    if (refusal !== null) {
      skipped.push({ seq: pending.seq, reason: refusal })
      continue
    }
    try {
      const plan = planTrim(session, ctx.tokenMeter, settings, pending)
      if (plan === null) {
        skipped.push({ seq: pending.seq, reason: 'within-budget' })
        continue
      }
      const entry = commitTrim(session, plan)
      trimmed.push(entry)
      charsRemoved += entry.charsBefore - entry.charsAfter
    } catch (error: unknown) {
      skipped.push({ seq: pending.seq, reason: 'off-surface' })
      ctx.logger.warn(
        `${LOG_PREFIX} leaving the result at seq ${pending.seq} of session ${session.id} `
        + `in place: the session refused the replacement: ${String(error)}`,
      )
    }
  }

  if (trimmed.length > 0) {
    ctx.logger.info(
      `${LOG_PREFIX} removed ${charsRemoved} characters of tool output from the model view `
      + `across ${trimmed.length} result${trimmed.length === 1 ? '' : 's'} in session ${session.id}`
      + ' (the full results remain in the session log)',
    )
  }
  return { trimmed, skipped, charsRemoved }
}

/**
 * The reasons a result is left alone before it is even priced.
 * @param session - the session the result is on.
 * @param state - that session's observation state.
 * @param settings - resolved budgets.
 * @param pending - the observed result.
 * @returns the reason, or `null` when the result should be priced.
 */
function refuse(
  session: Session,
  state: SessionState,
  settings: ResolvedConfig,
  pending: PendingResult,
): SkippedEntry['reason'] | null {
  // An unnamed result is budgeted: the promise is a budget on every tool result,
  // and a result whose call event this plugin never saw is not an exception.
  if (pending.toolName !== undefined && settings.exemptTools.includes(pending.toolName)) {
    return 'exempt-tool'
  }
  // A replacement needs an open turn — the live append accepts one without, and
  // the format validator that reads the log back does not. A log that cannot be
  // read is a far worse outcome than an unbounded result, so the append is not
  // attempted.
  if (!state.turnOpen) return 'no-open-turn'
  if (!session.surface.nodes.includes(pending.seq)) return 'off-surface'
  return null
}

export default { name, inject, apply }
