/**
 * The durable write: one shadow price and one surface replacement.
 *
 * ## What a committed trim does to a session
 *
 * ```text
 * compaction/prune     shadowedRange: { start: seq, end: seq }
 *                      shadowedSeqs: [seq]
 *                      shadowedTokenCount: <meter price of the shadowed node>
 * tool/result          the same event data, with `message.content` reduced
 *                      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }
 *                      sourceEventSeqs: [pruneSeq, seq]
 * ```
 *
 * Both source references are carried, as the shipped producers do: the shadowed
 * node because `assertSourceEventReferences` requires every replaced node to be
 * named, and the price event because a consumer reconstructing what produced this
 * replacement then needs no per-node bookkeeping to find its shadow price.
 *
 * The log keeps the original result forever; only the surface — the single
 * source of the model's history — changes. That is the whole point of choosing
 * this seam over rewriting the result as it is recorded: a user reading the
 * conversation, and any later replay, still sees what the tool actually printed.
 *
 * ## The pair cannot be split
 *
 * `@deepseek-ai/dsh-token-meter/surface-projection` folds a surface replacement
 * against a claim armed by the *immediately preceding* event and computes
 * `deltaTokens = tokens - claim.tokens`. A replacement with no adjacent claim
 * folds with a **zero** delta — the fold's own documented degradation, since
 * bounded state cannot reconstruct the replaced range's price — which leaves its
 * running total holding the price of content the request no longer carries. So
 * the two appends are synchronous and adjacent, and nothing may await between
 * them.
 *
 * The drift that would follow is in that incremental running total, **not** in
 * `TokenMeter.measure()`, which re-prices the current surface and therefore
 * agrees with a fixture built from the reduced text either way. A reader looking
 * for the difference in `measure()` will not find it; that is why the pair is
 * asserted here as a shape (adjacency, order, source references) rather than
 * inferred from a total that can only show the result.
 *
 * The price comes from the meter, never from arithmetic done here: the claim must
 * state exactly what the meter itself would have charged the shadowed node, and
 * the meter is the only thing that knows.
 *
 * ## Planning and committing are separate
 *
 * `planTrim` reads the session and decides; it writes nothing. `commitTrim`
 * writes the pair. A caller that only wants to know what a result would cost can
 * call the first one.
 *
 * @module @argszero/dsh-tool-output-budget/commit
 */
import type { ToolResultMessage } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session';
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import type { ResolvedConfig, TrimmedEntry } from './types.ts';
/**
 * One result this plugin observed and has not yet decided about.
 *
 * The event is carried rather than re-read: this plugin never calls
 * `Session.eventAt`, so the only copy of the original it will ever have is the
 * one the session handed it.
 */
export interface PendingResult {
    /** Log seq of the appended result. */
    readonly seq: SessionSeq;
    /** The appended event, exactly as the session published it. */
    readonly event: SessionEvent<'tool/result'>;
    /** Tool that produced it, when a preceding `tool/call` named one. */
    readonly toolName: string | undefined;
}
/** A trim this plugin has decided to make, but has not made. */
export interface TrimPlan {
    /** The result being replaced. */
    readonly pending: PendingResult;
    /** The message that will stand in for it, already frozen. */
    readonly message: ToolResultMessage;
    /** Text before the reduction, in Unicode code points. */
    readonly charsBefore: number;
    /** Text after the reduction, in Unicode code points. */
    readonly charsAfter: number;
    /** The shadow price the metering event must state. */
    readonly shadowedTokenCount: number;
}
/**
 * Decide whether one observed result is over budget, and price the reduction.
 *
 * The replacement is built from the **logged** message, not from the projected
 * one. `Session.append` refuses a `tool/result` replacement whose data differs
 * from the node it shadows in any field other than `message.content`, and a
 * plugin-owned message projection can rewrite other fields; building on the
 * logged message is what keeps that refusal out of reach. The *price* is taken
 * from the projected message, because that is what the meter charged the node at
 * append time and the claim must match it.
 *
 * @param session - session whose surface the result is on.
 * @param meter - the only pricer used here.
 * @param config - resolved budgets.
 * @param pending - the observed result.
 * @returns the plan, or `null` when the result is within budget or its weight is
 *   not in text at all.
 * @throws {Error} when the result leaves the surface between observation and
 *   planning, which is the one condition under which the pair would be refused.
 */
export declare function planTrim(session: Session, meter: TokenMeter, config: ResolvedConfig, pending: PendingResult): TrimPlan | null;
/**
 * Make one trim durable.
 *
 * The two appends are synchronous and adjacent on purpose — see this module's
 * header. Nothing may be awaited between them, and nothing is.
 *
 * @param session - the session the plan was priced against; it must not have
 *   changed since.
 * @param plan - the plan to commit.
 * @returns what was written.
 * @throws whatever the session's own append validation throws — the caller
 *   decides what to do with a write the session refused.
 */
export declare function commitTrim(session: Session, plan: TrimPlan): TrimmedEntry;
//# sourceMappingURL=commit.d.ts.map