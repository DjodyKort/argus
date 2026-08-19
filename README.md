# Argus

Watchman for CI. A spine for running model-assisted tasks over a repository without the two failure
modes that make people distrust them: burning tokens on the wrong context, and letting a model decide
something it should only have proposed.

```
route  →  context packet  →  skill  →  sink
```

| Stage | What it does | Where it lives |
|---|---|---|
| **route** | Get a model turn on the cheapest acceptable route, respecting quota, or conclude there isn't one | `.github/workflows/route.yml` |
| **context packet** | Decide what to look at and why, deterministically, before a model is involved | `packages/core`, `bin/argus.mjs` |
| **skill** | The prompt for a given task | a skills repo, not here |
| **sink** | PR comment, issue, or artifact | the calling workflow |

The first task is `merge-triage`: classify an incoming upstream range by risk to what a fork
guarantees. A CI reviewer or an improvement pass is a new rule set plus a new skill, not a rewrite -
that is the point of the packet being the contract.

## Why the deterministic pass exists

It is not a performance optimisation, it is the load-bearing part.

- **It works when no model does.** A home server can be off, a subscription rate limited, an API key
  revoked. When that happens you should still learn which parts of a change deserve eyes.
- **It is what makes a model affordable and reliable.** Feeding a 150-commit diff to a model is
  expensive and unfocused. The model reads the packet and deep-reads only what is flagged.
- **It is reviewable.** A rule set is a diff. A prompt's judgement is not.

## Design rules

These are enforced in code, not just described here.

1. **Propose, never decide.** `output.mustNot` carries the prohibitions and cannot be emptied - passing
   an empty array is rejected, so the guarantee cannot be opted out of by omission. A sink should be
   structurally unable to push to a protected branch. Every "AI in CI" story that ends badly ends badly
   because this was a guideline instead of a boundary.
2. **Probe, never assume.** A service that is installed is not a service that is running; a token that
   authenticates is not a token that draws the pool you expected. `route.yml` curls before it commits,
   and reports what it found.
3. **"No route" is a valid outcome.** Not an error. The deterministic pass and the repo's own gates
   never depended on a model.
4. **A silent no-match is a reportable state.** An empty result says the rule set matched nothing, not
   that nothing is wrong. The renderer says so in those words, because "no findings" reads as "all
   clear" to a tired person.
5. **Repo-specific knowledge stays in the repo.** Rule sets and invariants live with the thing they
   describe. Argus ships an example rule set and no real ones.
6. **No dependencies in core.** It has to run on any box with node and nothing else.
   `schemas/packet.schema.json` is the published contract; validation is hand-written to keep it that
   way.

## Use

```bash
node bin/argus.mjs packet \
  --task merge-triage \
  --rules path/to/your/rules.json \
  --config path/to/your/argus.config.json \
  --head upstream/main
```

With no `--base`, the range is `merge-base(HEAD, head)..head`, which answers "what is about to arrive"
rather than "how do these two branches differ". Those are different questions, and the difference is
not academic: measured on a real 30-commit merge, the branch-to-branch form reported 347 files and 11
high-risk findings, while the correct ancestor range reported 195 and 4. The extra ones were the local
side's own work, because `git diff a..b` is symmetric. A packet carries `baseIsAncestor` and the
renderer warns when it is false, because the wrong version is worse than useless: it looks
authoritative.

Add `--json` for a packet a task can consume, `--out <file>` to write it. Exit code is 0 even with
findings - this reports, it does not gate. Exit 2 means the invocation was wrong, which is a different
thing and is meant to be loud.

## Status

Scaffold. `packages/core` and the CLI work and are tested (`npm test`); `route.yml` is reusable and its
degraded path is verified end to end. Not yet built: the task runner that takes a packet plus a skill
and produces a report, and the sinks. The plugin/registry layer is deliberately absent until a second
real task exists - two instances is when the shape becomes knowable, and one instance is when it
becomes guesswork.
