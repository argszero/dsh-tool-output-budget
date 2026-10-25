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
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './types.ts';
export { codePointLength, DEFAULTS, resolveConfig, TRIM_MARKER } from './config.ts';
export { measureContent, trimContent } from './trim.ts';
export { commitTrim, planTrim } from './commit.ts';
export type { PendingResult, TrimPlan } from './commit.ts';
export type { Config, ResolvedConfig, SkippedEntry, TrimmedEntry, TrimResult } from './types.ts';
/** Cordis plugin name, used by loader diagnostics. */
export declare const name = "tool-output-budget";
/**
 * The one service this plugin needs: the meter that prices the shadow claim.
 *
 * The claim must state exactly what the meter itself charged the shadowed node,
 * and the meter is the only thing that knows — so a session without it cannot
 * have its surface replaced *correctly*, and the dependency is required rather
 * than probed. `@deepseek-ai/dsh-token-meter` is in the base bundle of every
 * shipped profile.
 */
export declare const inject: readonly string[];
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
export declare function apply(ctx: Context, config?: Config): void;
declare const _default: {
    name: string;
    inject: readonly string[];
    apply: typeof apply;
};
export default _default;
//# sourceMappingURL=index.d.ts.map