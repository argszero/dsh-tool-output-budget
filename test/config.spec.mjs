/**
 * The configuration surface, measured without a world.
 *
 * Every arm here is about a refusal: a budget this plugin cannot honour must
 * stop the mount rather than quietly policing requests with a different budget
 * than the one an operator wrote down. The one arm about a value that *is*
 * accepted checks the defaults, because the defaults are the whole configuration
 * for most deployments.
 *
 * @module test/config.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULTS, TRIM_MARKER, codePointLength, resolveConfig } from '../lib/index.js'

/** The shipped pruner's marker, which this plugin must never write. */
const PRUNER_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

describe('resolveConfig', () => {
  it('applies the documented defaults to an empty configuration', () => {
    const resolved = resolveConfig()
    assert.equal(resolved.thresholdChars, 16_384)
    assert.equal(resolved.headChars, 8_192)
    assert.equal(resolved.tailChars, 2_048)
    assert.deepEqual([...resolved.exemptTools], [])
    assert.equal(resolved.thresholdChars, DEFAULTS.thresholdChars)
  })

  it('defaults only the keys that were omitted', () => {
    const resolved = resolveConfig({ headChars: 10 })
    assert.equal(resolved.headChars, 10)
    assert.equal(resolved.thresholdChars, DEFAULTS.thresholdChars)
    assert.equal(resolved.tailChars, DEFAULTS.tailChars)
  })

  it('returns a frozen, detached configuration', () => {
    const exempt = ['read_file']
    const resolved = resolveConfig({ exemptTools: exempt })
    exempt.push('bash')
    assert.deepEqual([...resolved.exemptTools], ['read_file'])
    assert.ok(Object.isFrozen(resolved))
    assert.ok(Object.isFrozen(resolved.exemptTools))
  })

  it('rejects an unknown key rather than ignoring it', () => {
    assert.throws(
      () => resolveConfig({ threshold: 100 }),
      /unknown key "threshold"/u,
    )
  })

  it('rejects a configuration that is not a plain object', () => {
    assert.throws(() => resolveConfig(null), /must be an object/u)
    assert.throws(() => resolveConfig([]), /must be an object/u)
    assert.throws(() => resolveConfig('thresholdChars=10'), /must be an object/u)
  })

  it('rejects a threshold that is not a positive safe integer', () => {
    assert.throws(() => resolveConfig({ thresholdChars: 0 }), /thresholdChars must be a positive integer/u)
    assert.throws(() => resolveConfig({ thresholdChars: -1 }), /thresholdChars must be a positive integer/u)
    assert.throws(() => resolveConfig({ thresholdChars: 10.5 }), /thresholdChars must be a positive integer/u)
    assert.throws(() => resolveConfig({ thresholdChars: Number.NaN }), /thresholdChars must be a positive integer/u)
  })

  it('accepts zero for the retained ends but rejects negatives', () => {
    const resolved = resolveConfig({ thresholdChars: 100, headChars: 0, tailChars: 0 })
    assert.equal(resolved.headChars, 0)
    assert.equal(resolved.tailChars, 0)
    assert.throws(() => resolveConfig({ headChars: -1 }), /headChars must be a non-negative integer/u)
    assert.throws(() => resolveConfig({ tailChars: -1 }), /tailChars must be a non-negative integer/u)
  })

  it('rejects a budget whose emitted span would not shrink the result', () => {
    // head + marker + tail must fit inside the threshold, or "trimming" an
    // accepted result would leave the surface the same size or larger.
    assert.throws(
      () => resolveConfig({ thresholdChars: 100, headChars: 60, tailChars: 40 }),
      /must not exceed thresholdChars/u,
    )
  })

  it('accepts the exact boundary where the emitted span equals the threshold', () => {
    const marker = codePointLength(TRIM_MARKER)
    const resolved = resolveConfig({ thresholdChars: 200, headChars: 60, tailChars: 200 - 60 - marker })
    assert.equal(resolved.thresholdChars, 200)
    assert.equal(resolved.headChars + marker + resolved.tailChars, 200)
  })

  it('rejects a malformed exemption list', () => {
    assert.throws(() => resolveConfig({ exemptTools: 'bash' }), /must be an array/u)
    assert.throws(() => resolveConfig({ exemptTools: ['bash', 7] }), /non-empty strings/u)
    assert.throws(() => resolveConfig({ exemptTools: [''] }), /non-empty strings/u)
  })

  it('de-duplicates an exemption list', () => {
    const resolved = resolveConfig({ exemptTools: ['bash', 'bash', 'read_file'] })
    assert.deepEqual([...resolved.exemptTools], ['bash', 'read_file'])
  })
})

describe('the trim marker', () => {
  it('is not the shipped pruner\u2019s marker', () => {
    // Two producers write two markers, so a trimmed result says which one
    // trimmed it. Collapsing them would make a session's own log ambiguous about
    // which rule set applied to a given result.
    assert.notEqual(TRIM_MARKER, PRUNER_MARKER)
    assert.ok(TRIM_MARKER.includes('over budget'))
    assert.ok(!TRIM_MARKER.includes('pruned'))
  })
})

describe('codePointLength', () => {
  it('counts astral characters as one, unlike String#length', () => {
    assert.equal('😀'.length, 2)
    assert.equal(codePointLength('😀'), 1)
    assert.equal(codePointLength('a😀b'), 3)
  })
})
