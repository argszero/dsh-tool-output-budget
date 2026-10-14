/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is SILENT —
 * it proves nothing about the test that was supposed to hold the line.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm rebuilds with tsc
 * first; a mutation that fails to type-check proves nothing either, and is
 * reported separately as UNBUILDABLE. The source is restored **and rebuilt**
 * whatever happened: an injector that can leave a mutation (or a stale `lib/`) in
 * the tree would be worse than no injector, and a stale `lib/` is exactly how an
 * arm goes SILENT.
 *
 * Every mutation here is a defect this plugin could plausibly ship — a bound
 * loosened, a deferral skipped, a price read from the wrong message, a guard
 * removed, a reduction that reduces nothing. None is engineered to be caught: each
 * names the shape of mistake the arm exists for.
 *
 * The whole suite runs for every arm (it takes a fraction of a second), so an arm
 * may be caught by more than one test; what is asserted is that SOMETHING goes
 * red, which is the only thing a mutation can prove on its own.
 *
 * Run from the plugin root: `npm run test:inject`.
 *
 * The control arm is the unmutated suite, run first: every mutant is compared
 * against a suite that is known green, so a manifest-wide failure (a broken
 * dependency, a missing build) cannot be mistaken for a caught defect.
 *
 * The anchors are source *prose*, so an edit to a mutated line re-anchors its arm
 * in the same change — a missing anchor is reported as SKIP and fails the run
 * rather than quietly proving less.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SUITE = '*.spec.mjs'

const MUTATIONS = [
  // ---------------------------------------------------------------- trim.ts
  {
    name: 'a result exactly at the threshold is trimmed, so the budget is one character tighter than it says',
    file: 'src/trim.ts',
    edits: [['  if (totalChars <= config.thresholdChars) return null', '  if (totalChars < config.thresholdChars) return null']],
  },
  {
    name: 'blocks are sliced by UTF-16 code unit, so a retained boundary can leave a lone surrogate',
    file: 'src/trim.ts',
    edits: [['    const points = Array.from(block.text)', "    const points = block.text.split('')"]],
  },
  {
    name: 'the marker is inserted per intersecting block, so one elision reads as several',
    file: 'src/trim.ts',
    edits: [[
      "    const marker = intersectsRemoved && !markerInserted ? TRIM_MARKER : ''",
      '    const marker = intersectsRemoved ? TRIM_MARKER : \'\'',
    ]],
  },
  {
    name: 'non-text blocks are dropped instead of carried, so an image in a long result is lost',
    file: 'src/trim.ts',
    edits: [[
      "    if (block.type !== 'text') {\n      trimmed.push(block)\n      continue\n    }",
      "    if (block.type !== 'text') {\n      continue\n    }",
    ]],
  },
  {
    name: 'blocks the reduction emptied are kept as empty text, so the replacement is not the minimal one',
    file: 'src/trim.ts',
    edits: [['    if (text.length > 0) trimmed.push({ ...block, text })', '    trimmed.push({ ...block, text })']],
  },
  // -------------------------------------------------------------- config.ts
  {
    name: 'length is counted in UTF-16 code units, so an astral character weighs two',
    file: 'src/config.ts',
    edits: [['  return Array.from(text).length', '  return text.length']],
  },
  {
    name: 'an unknown configuration key is accepted, so a misspelled knob mounts and budgets nothing',
    file: 'src/config.ts',
    edits: [['    if (!CONFIG_KEYS.has(key)) {', "    if (key === '__never_known__') {"]],
  },
  {
    name: 'a zero threshold is accepted, so every non-empty result is reduced to head plus marker plus tail',
    file: 'src/config.ts',
    edits: [["  assertInteger('thresholdChars', thresholdChars, 1)", "  assertInteger('thresholdChars', thresholdChars, 0)"]],
  },
  {
    name: 'the positive-integer check is loosened, so NaN and a fractional budget reach the reducer',
    file: 'src/config.ts',
    edits: [['  if (!Number.isSafeInteger(value) || value < minimum) {', '  if (value < minimum) {']],
  },
  {
    name: 'the emitted span is allowed to equal the threshold, so a budget that would not shrink a result mounts',
    file: 'src/config.ts',
    edits: [['  if (emittedChars > thresholdChars) {', '  if (emittedChars >= thresholdChars) {']],
  },
  {
    name: 'the exemption list keeps duplicates, so the resolved configuration is not the frozen normal form',
    file: 'src/config.ts',
    edits: [['    if (!exemptTools.includes(name)) exemptTools.push(name)', '    exemptTools.push(name)']],
  },
  {
    name: 'the reduction writes the shipped pruner marker, so nothing can say which producer trimmed a result',
    file: 'src/config.ts',
    edits: [[
      "export const TRIM_MARKER = '\\n\\n[... tool output over budget: middle removed from the model view ...]\\n\\n'",
      "export const TRIM_MARKER = '\\n\\n[... tool result middle pruned ...]\\n\\n'",
    ]],
  },
  // -------------------------------------------------------------- commit.ts
  {
    name: 'the shadow claim prices the logged text instead of the message the model is sent',
    file: 'src/commit.ts',
    edits: [['  const priced = derived !== null && derived.role === \'tool\' ? derived : logged', '  const priced = logged']],
  },
  {
    name: 'the whole write is assembled from the projected message, so a projection that rewrites another field makes the session refuse it',
    file: 'src/commit.ts',
    edits: [[
      '  const logged = pending.event.data.message',
      '  const logged = (session.deriveEventMessage(pending.event) ?? pending.event.data.message) as ToolResultMessage',
    ]],
  },
  {
    name: 'the replacement stops reducing anything, so the pair is written and the surface keeps the whole result',
    file: 'src/commit.ts',
    edits: [[
      '  const replacement = session.append(\'tool/result\', {\n    ...pending.event.data,\n    message,\n  }, {',
      '  const replacement = session.append(\'tool/result\', {\n    ...pending.event.data,\n    message: pending.event.data.message,\n  }, {',
    ]],
  },
  {
    name: 'the replacement appends instead of replacing, so the over-budget result stays on the surface',
    file: 'src/commit.ts',
    edits: [[
      "    surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },",
      "    surfaceOp: 'append',",
    ]],
  },
  {
    name: 'only the claim is cited, so a consumer cannot pair the shadow price with the node it replaces',
    file: 'src/commit.ts',
    edits: [['    sourceEventSeqs: [prune.seq, seq],', '    sourceEventSeqs: [prune.seq],']],
  },
  {
    name: 'no shadowed node is named, so the session cannot verify the range the claim prices',
    file: 'src/commit.ts',
    edits: [['    shadowedSeqs: [seq],', '    shadowedSeqs: [],']],
  },
  {
    name: 'the claim is priced without a plan, so the metering event states the price of nothing',
    file: 'src/commit.ts',
    edits: [['    shadowedTokenCount: plan.shadowedTokenCount,', '    shadowedTokenCount: 0,']],
  },
  // --------------------------------------------------------------- index.ts
  {
    name: 'the plugin inspects its own replacement, so a trimmed result is trimmed again without end',
    file: 'src/index.ts',
    edits: [["      if (event.surfaceOp !== 'append') return", '      if (false) return']],
  },
  {
    name: 'a result that left the surface is planned anyway, so the pair prices a range it does not own',
    file: 'src/commit.ts',
    edits: [[
      '  if (!session.surface.nodes.includes(pending.seq)) {',
      '  if (false) {',
    ]],
  },
  {
    name: 'the append is attempted inside the publication that delivered the event, so every trim throws and is swallowed',
    file: 'src/index.ts',
    edits: [[
      '    queueMicrotask(() => {\n      state.queued = false\n      drain(ctx, session, state, settings)\n    })',
      '    state.queued = false\n    drain(ctx, session, state, settings)',
    ]],
  },
  {
    name: 'the pre-step barrier never drains, so nothing is guaranteed to be committed before the request that carries it',
    file: 'src/index.ts',
    edits: [['    if (state.pending.length > 0) drain(ctx, agent.session, state, settings)', '    if (state.pending.length < 0) drain(ctx, agent.session, state, settings)']],
  },
  {
    name: 'the pre-step listener is installed last, so the shipped pressure decision prices the unreduced surface',
    file: 'src/index.ts',
    edits: [['  }, { prepend: true })', '  })']],
  },
  {
    name: 'the closed-turn guard is inverted, so a replacement is attempted where the log would stop loading',
    file: 'src/index.ts',
    edits: [["  if (!state.turnOpen) return 'no-open-turn'", "  if (state.turnOpen) return 'no-open-turn'"]],
  },
  {
    name: 'a turn start is recorded as closed, so the plugin never writes at all',
    file: 'src/index.ts',
    edits: [['      state.turnOpen = true', '      state.turnOpen = false']],
  },
  {
    name: 'the exemption list is inverted, so every tool except the named ones is left unbounded',
    file: 'src/index.ts',
    edits: [[
      '  if (pending.toolName !== undefined && settings.exemptTools.includes(pending.toolName)) {',
      '  if (pending.toolName === undefined || !settings.exemptTools.includes(pending.toolName)) {',
    ]],
  },
  {
    name: 'the removed-character count is not accumulated, so the report understates what was removed',
    file: 'src/index.ts',
    edits: [['      charsRemoved += entry.charsBefore - entry.charsAfter', '      charsRemoved += 0']],
  },
  {
    name: 'the drain reports a removal even when it removed nothing, so the log claims work that did not happen',
    file: 'src/index.ts',
    edits: [['  if (trimmed.length > 0) {', '  if (trimmed.length >= 0) {']],
  },
]

/** Rebuild `lib/` from `src/`; true when tsc accepted the tree. */
function build() {
  try {
    execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')], { cwd: ROOT, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** Run the suite; true when it failed, plus its output. */
function runSuite() {
  try {
    execFileSync(process.execPath, ['--test', `test/${SUITE}`], { cwd: ROOT, stdio: 'pipe' })
    return { failed: false, output: '' }
  } catch (error) {
    return { failed: true, output: String(error.stdout ?? '') + String(error.stderr ?? '') }
  }
}

// The control arm: the unmutated tree. A suite that is red on its own makes every
// CAUGHT below meaningless, so it is asserted rather than assumed.
if (!build()) {
  console.log('CONTROL UNBUILDABLE: src/ does not compile, no arm below proves anything')
  process.exit(1)
}
const control = runSuite()
if (control.failed) {
  console.log('CONTROL RED: the unmutated suite fails, no arm below proves anything')
  console.log(control.output)
  process.exit(1)
}
console.log('CONTROL: the unmutated suite is green')

let silent = 0
let unbuildable = 0
let missing = 0
for (const mutation of MUTATIONS) {
  const path = join(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let anchored = true
  for (const [find, replace] of mutation.edits) {
    if (!original.includes(find)) {
      anchored = false
      console.log(`SKIP (anchor missing): ${mutation.name}`)
    }
    mutated = mutated.replace(find, replace)
  }
  if (!anchored) {
    missing += 1
    continue
  }

  writeFileSync(path, mutated)
  let built = false
  let result = { failed: false, output: '' }
  try {
    built = build()
    if (built) result = runSuite()
  } finally {
    // Restore the source and rebuild, whatever happened: leaving either a mutation
    // or a stale `lib/` behind is the failure mode this file exists to avoid.
    writeFileSync(path, original)
    build()
  }

  if (!built) {
    unbuildable += 1
    console.log(`UNBUILDABLE (proves nothing): ${mutation.name}`)
    continue
  }
  const caught = result.failed && /fail [1-9]/.test(result.output)
  if (!caught) silent += 1
  console.log(`${caught ? 'CAUGHT' : 'SILENT'}: ${mutation.name}`)
}
console.log(`SILENT ARMS: ${silent === 0 ? 'none' : String(silent)}; UNBUILDABLE: ${String(unbuildable)}; ANCHOR MISSING: ${String(missing)}`)
if (silent > 0 || unbuildable > 0 || missing > 0) process.exit(1)
