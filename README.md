# @argszero/dsh-tool-output-budget

Every tool result a model is asked to read stays in the session's history and is
charged again on every later request of that session — so one 3 MB build log, one
read of a generated bundle, one recursive grep is paid for on every turn, forever.
This plugin bounds each result as it arrives: the head, a marker and the tail are
kept, the middle is removed **from the model's view only**, and the tool's real
output stays in the session log.

A [Cordis](https://github.com/deepseek-ai/deepseek-harness) plugin for the
DeepSeek Harness — an independent npm package, mounted through `dsh.bundle.patch`.
It changes no core package and works on the released lines `0.1.7-rc.2`,
`0.2.0-rc.2` and `0.2.1-alpha.2`.

## The defect

A tool result enters history exactly as the tool printed it, and nothing in the
harness bounds it. Discussion [#9583](https://github.com/deepseek-ai/deepseek-harness/discussions/9583)
measured the cost on a 21-subagent run:

| | |
|---|---|
| context replayed per request | 36,454 tokens (average) |
| output produced per request | 686 tokens (average) |
| ratio | **53 : 1** |
| total | 108,842,852 tokens, ¥46.94 |

The harness does ship a reducer for exactly this content —
`@deepseek-ai/dsh-compaction-tool-result-pruner`, which keeps the head and the
tail of an over-long result and drops the middle — but it is **gated on
compaction pressure**: its own README says below-pressure conversations remain
unchanged. The unbounded window is therefore *before* the pressure, and that
window is where a long run lives: twenty oversized results are replayed for twenty
turns while the session is nowhere near its context limit.

## What it does

The plugin listens on `session/event`, notices each `tool/result` as it is
appended, and — once the appending call stack has unwound — replaces the ones over
budget with the head, a marker and the tail of the same result. It is the shipped
reducer's operation performed at injection time instead of under pressure, with a
deliberately looser default budget (16 KiB rather than 8 KiB) because it runs on
every ordinary request rather than only when the session is already in trouble.

The marker is its own:

```text
[... tool output over budget: middle removed from the model view ...]
```

distinct from the pruner's `[... tool result middle pruned ...]`, so a trimmed
result says which producer trimmed it.

Every tool is in scope — there is no allow-list to fall off — and `exemptTools` is
the escape hatch. Only **text** is bounded: a result whose weight is in image,
resource or file blocks is left alone, which is the honest outcome for a plugin
that bounds text.

### The write, and why it is this one

The result is **not** rewritten as it is recorded. `tools/post-execute` could do
that and it would be simpler, but it would write the reduced text into the durable
log, and the tool's real output would then exist nowhere — for the user reading
the conversation no less than for a replay. The plugin writes the pair the shipped
producers already define for exactly this:

```text
compaction/prune     shadowedRange, shadowedSeqs, shadowedTokenCount
tool/result          the same result with reduced content
                     surfaceOp: { op: 'replace', startSeq, endSeq }
                     sourceEventSeqs: [pruneSeq, seq]
```

The log keeps the original forever; only the surface — the single source of the
model's history — changes. The shadow claim is priced by the token meter, never by
arithmetic done here, and from the **same message the shipped producer prices**
(the node as `deriveEventMessage` resolves it), so a consumer subtracting one from
the other gets the same answer whichever producer wrote the pair.

The two appends are synchronous and adjacent, because the meter's surface fold
reads them that way (`packages/llm/token-meter/src/surface-projection.ts`): a
shadow-price event arms a claim for the very next event, and a replacement
consumes it. A replacement with no adjacent claim folds with a **zero** delta,
which would leave the running total holding the price of content the request no
longer carries.

### The write is deferred, and it has to be

`Session.append` refuses a reentrant append — *"session append cannot reenter while
another append is being published"* — and a `session/event` listener runs **inside**
that publication. A plugin that appends from the listener throws on its first tool
result. So the append is queued and drained from a microtask, which runs as soon as
the appending call stack unwinds; a second drain runs at `agent/pre-step`,
prepended so the shipped pressure decision sees the reduced surface on the same
waterfall rather than after it.

The listener is installed with `prepend: true` for the same reason: a plugin
mounted later must still run **before** the compaction engine's measurement, or it
would hand the session to an expensive summarization to fix exactly the weight it
had already removed.

### Why it cannot loop or wedge a session

- **It never inspects a replacement**, its own or another producer's. Only an
  appended result carries new tool output.
- **A budget that would not shrink a result is refused at mount.** `head + marker
  + tail` may not exceed the threshold, so a configuration that would leave every
  result the same size never loads.
- **A result is never replaced with no turn open.** The live append accepts it and
  the format validator that reads the log back does not; an unbounded result is a
  far cheaper outcome than a session that will not load.
- **A node that left the surface is never shadowed.** The pair names its range by
  current surface position, so a stale decision is refused rather than appended.
- **A refused write never breaks a turn.** A drain reports the refusal and leaves
  the result in place; making a request smaller is not worth failing a step for.

## Install

```sh
dsh plugin --profile <profile> add github:argszero/dsh-tool-output-budget
```

The git spec installs the tree this README describes; `npm install` on its own never attaches a plugin to a profile — `dsh plugin add` is what writes the row that makes it load.

Then mount it from your profile's bundle patch (`dsh.bundle.patch`):

```yaml
- insert:
    - id: tool-output-budget
      name: '@argszero/dsh-tool-output-budget'
```

Or, if you compose `cordis.yml` by hand:

```yaml
- set:
    - id: tool-output-budget
      name: '@argszero/dsh-tool-output-budget'
      config:
        thresholdChars: 16384
```

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `thresholdChars` | `16384` | Text (Unicode code points) above which one result is reduced. |
| `headChars` | `8192` | Text kept verbatim at the **start** of the result: the path, the command, the exit status, the first error. |
| `tailChars` | `2048` | Text kept verbatim at the **end** of the result: the failing count, the summary line. |
| `exemptTools` | `[]` | Tool names whose results are never bounded. |

Boundaries are **code points**, not UTF-16 code units, so a retained boundary can
never leave a lone surrogate in a request.

A configuration the plugin cannot honour is refused at mount rather than quietly
replaced: an unknown key, a non-positive or non-integer threshold, a malformed
exemption list, or a budget whose emitted span would not shrink the result. A
misspelled knob that mounts and does nothing is how an operator believes a budget
is in force when it is not.

## Diagnostics

One line per drain that removed something, and nothing when it removed nothing:

```
tool-output-budget: removed 6120 characters of tool output from the model view across 2 results in session … (the full results remain in the session log)
```

A write the session refused is warned about with the result's seq and the session
id, and the result is left in place.

## What it is not

- **It is not the shipped pruner, and it does not replace it.** They overlap in
  shape and differ in trigger: this one is unconditional, that one runs under
  pressure. The two budgets are independent — a result this plugin reduced is
  still eligible for the pruner's tighter default, and a result the pruner already
  reduced is not re-reduced here, because this plugin bounds results as they arrive
  and never re-decides a replacement another producer has written.
- **It does not touch history it did not watch arrive.** A session resumed with
  pre-existing oversized results keeps them; the plugin reads no past events at
  all. Mounting it on a long-running session bounds everything from that point on.
- **It does not summarize and calls no model.** Nothing here needs a provider, a
  key, or a network.
- **It is not lossless, and it does not pretend to be.** The middle of an
  oversized result is gone from the request. The marker says so where the model
  will read it, and the full output is still in the log for the user.

## Evidence

- `test/budget.spec.mjs` — the behaviour against a real Cordis context: what is
  bounded, what is left alone, the deferral and the pre-step barrier, the
  exemption list, session scope, and the log lines.
- `test/surface.spec.mjs` — the shape of the write: the log keeps the tool's real
  output, the claim and its replacement are adjacent, the claim is priced from the
  message the model is sent, and the surface keeps its other nodes and their order.
- `test/trim.spec.mjs`, `test/config.spec.mjs` — the pure reduction and the
  configuration rules, which need no world at all.
- `test/harness.mjs` — a real Cordis context carrying the real `LlmRuntime`,
  `SessionProjectionRegistry`, `TokenMeter` and `SessionStore`, so the surface
  fold, the append validation and the prices are the shipped ones.
- `npm run test:inject` — mutates the source, rebuilds, and requires each mutation
  to be caught by the suite. An arm whose mutation leaves the suite green proves
  nothing about the test that was supposed to hold the line, and is reported as
  `SILENT`.
- `npm run probe:lines` — runs the suite once per released line, which is where the
  supported-lines list above comes from.

## License

MIT.
