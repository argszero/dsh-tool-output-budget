/**
 * Configuration resolution for the injection-time tool-output budget.
 *
 * The vocabulary deliberately matches
 * `@deepseek-ai/dsh-compaction-tool-result-pruner` — threshold/head/tail in
 * Unicode code points — because this plugin performs the same replacement at a
 * different moment, and an operator who has tuned one has already tuned the
 * other. The two defaults differ on purpose: the shipped pruner runs only once
 * pressure is already a problem, so it may be aggressive, while this one runs on
 * every ordinary request and therefore only removes output no model can use.
 *
 * The marker is NOT the pruner's: two producers write two different markers, so
 * a trimmed result says which one trimmed it.
 *
 * @module @argszero/dsh-tool-output-budget/config
 */
/**
 * Fixed marker substituted for every removed middle span.
 *
 * Distinct from the compaction pruner's `[... tool result middle pruned ...]`
 * because a reader — and a test — must be able to tell which producer made a
 * given replacement, and because the two producers act under different rules.
 */
export const TRIM_MARKER = '\n\n[... tool output over budget: middle removed from the model view ...]\n\n';
/**
 * Defaults for a plugin that is unconditional rather than pressure-gated.
 *
 * 16 KiB of text (roughly four thousand tokens) is already an oversized single
 * result, and 8 KiB + marker + 2 KiB is what the model keeps. The shipped pruner
 * defaults to half that because it only ever runs when the session is already
 * in trouble.
 */
export const DEFAULTS = Object.freeze({
    thresholdChars: 16_384,
    headChars: 8_192,
    tailChars: 2_048,
    exemptTools: Object.freeze([]),
});
const CONFIG_KEYS = new Set([
    'thresholdChars',
    'headChars',
    'tailChars',
    'exemptTools',
]);
/**
 * Count Unicode code points without splitting surrogate pairs.
 * @param text - text to measure.
 * @returns the Unicode code-point count.
 */
export function codePointLength(text) {
    return Array.from(text).length;
}
function assertInteger(name, value, minimum) {
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`tool-output-budget config: ${name} must be ${minimum === 1 ? 'a positive' : 'a non-negative'} integer`);
    }
}
/**
 * Resolve, validate and detach the trimming budgets.
 *
 * The refusal of an unknown key is deliberate: a misspelled knob that mounts and
 * does nothing is how an operator believes a budget is in force when it is not.
 * @param config - raw plugin configuration, possibly empty.
 * @returns a detached, frozen configuration.
 * @throws {Error} when a budget is not a usable integer, when the emitted span
 *   would not be smaller than the threshold it replaces, or when a key is
 *   unknown.
 */
export function resolveConfig(config = {}) {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('tool-output-budget config: must be an object');
    }
    for (const key of Object.keys(config)) {
        if (!CONFIG_KEYS.has(key)) {
            throw new Error(`tool-output-budget config: unknown key "${key}" `
                + '(allowed: thresholdChars, headChars, tailChars, exemptTools)');
        }
    }
    const thresholdChars = config.thresholdChars ?? DEFAULTS.thresholdChars;
    const headChars = config.headChars ?? DEFAULTS.headChars;
    const tailChars = config.tailChars ?? DEFAULTS.tailChars;
    assertInteger('thresholdChars', thresholdChars, 1);
    assertInteger('headChars', headChars, 0);
    assertInteger('tailChars', tailChars, 0);
    // A valid configuration must shrink every result it accepts, so the emitted
    // span can never grow past the threshold it replaced.
    const emittedChars = headChars + codePointLength(TRIM_MARKER) + tailChars;
    if (emittedChars > thresholdChars) {
        throw new Error(`tool-output-budget config: headChars + marker + tailChars (${emittedChars}) `
            + `must not exceed thresholdChars (${thresholdChars})`);
    }
    const raw = config.exemptTools ?? [];
    if (!Array.isArray(raw)) {
        throw new Error('tool-output-budget config: exemptTools must be an array of tool names');
    }
    const exemptTools = [];
    for (const name of raw) {
        if (typeof name !== 'string' || name.length === 0) {
            throw new Error('tool-output-budget config: exemptTools entries must be non-empty strings');
        }
        if (!exemptTools.includes(name))
            exemptTools.push(name);
    }
    return Object.freeze({
        thresholdChars,
        headChars,
        tailChars,
        exemptTools: Object.freeze(exemptTools),
    });
}
