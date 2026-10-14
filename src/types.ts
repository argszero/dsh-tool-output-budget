/**
 * Types for the injection-time tool-output budget.
 *
 * @module @argszero/dsh-tool-output-budget/types
 */

import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session'

/**
 * Raw plugin configuration as mounted from a profile entry.
 *
 * Every field is optional: the plugin is useful with no configuration at all,
 * and an empty `exemptTools` means "every tool is in scope".
 */
export interface Config {
  /** Trim a tool result whose text exceeds this many Unicode code points. */
  thresholdChars?: number
  /** Leading Unicode code points retained. */
  headChars?: number
  /** Trailing Unicode code points retained. */
  tailChars?: number
  /**
   * Tool names this plugin must never trim.
   *
   * An exemption list rather than an inclusion list on purpose: the plugin's
   * promise is an unconditional budget on every tool result, and an inclusion
   * list would silently un-budget every tool an operator did not think of —
   * a new MCP server's first `fetch` would sail past the budget that was
   * supposed to cover it.
   */
  exemptTools?: string[]
}

/** Detached, validated budgets. */
export interface ResolvedConfig {
  readonly thresholdChars: number
  readonly headChars: number
  readonly tailChars: number
  readonly exemptTools: readonly string[]
}

/** One committed replacement of an over-budget result. */
export interface TrimmedEntry {
  /** Log seq of the original `tool/result` node, still durable and unchanged. */
  readonly originalSeq: SessionSeq
  /** Log seq of the replacement `tool/result` node now on the surface. */
  readonly replacementSeq: SessionSeq
  /** Seq of the shadow-price event that prices the replacement. */
  readonly pruneSeq: SessionSeq
  /** Provider-issued id of the call the result answers. */
  readonly callId: ToolCallId
  /** Tool that produced the result, when a `tool/call` named it. */
  readonly toolName: string | undefined
  /** Unicode code points in the model-visible content before the replacement. */
  readonly charsBefore: number
  /** Unicode code points in the model-visible content after the replacement. */
  readonly charsAfter: number
}

/** One result this plugin looked at and left alone. */
export interface SkippedEntry {
  /** Log seq of the inspected `tool/result` node. */
  readonly seq: SessionSeq
  /** Why it was left alone. */
  readonly reason: 'within-budget' | 'exempt-tool' | 'no-open-turn' | 'off-surface'
}

/** What one pass over the pending results did. */
export interface TrimResult {
  /** Replacements that landed, in the order the results arrived. */
  readonly trimmed: readonly TrimmedEntry[]
  /** Results inspected and left alone. */
  readonly skipped: readonly SkippedEntry[]
  /** Aggregate Unicode code points removed from the model view. */
  readonly charsRemoved: number
}
