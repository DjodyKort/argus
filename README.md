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

## Pushing from a workflow

No task here pushes yet, and the moment one does — an improvement pass that commits a fix, a codemod
that opens a branch — it will hit this, so it is written down before it costs anyone else four attempts.

**Two credentials competing over one push is the whole problem.** `actions/checkout` configures an
Authorization header for the job's GitHub App token. Supplying your own token does not replace it:

| attempt | result |
|---|---|
| token in the push URL | silently outranked; a header beats userinfo, so the push goes out as the App |
| `git config --unset http.https://github.com/.extraheader` | matches nothing; checkout@v6 wires credentials in through `includeIf`, not as a key in the local config |
| `git -c http…extraheader=…` alongside it | `remote: Duplicate header: "Authorization"`, HTTP 400 |
| **checkout stores none, you supply exactly one** | works |

So:

```yaml
- uses: actions/checkout@v6
  with:
    persist-credentials: false
```

```bash
auth_header="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"
git -c http.https://github.com/.extraheader="$auth_header" push origin "$branch"
```

Fetching a public repository unauthenticated is fine, so removing checkout's credential costs nothing.

**And know which token you need.** `GITHUB_TOKEN` may not create or update anything under
`.github/workflows`, and there is no `workflows` permission a workflow can grant itself, so no
`permissions:` block fixes it. Pushing a change that touches a workflow file needs a PAT with
Workflows: write, or a GitHub App installation token. Detect that case *before* pushing and say so:
the bare failure is `error: failed to push some refs`, which gives no hint that the cause is a
permission GitHub will never grant.

The generalisable lesson: **when an authentication failure names a credential you did not choose, stop
trying to out-argue the one already there and remove it.**

## Status

Working and tested: `packages/core` (rules engine, packet, deep read, model adapters, report), the
CLI's `packet` and `run` commands, and both reusable workflows. 28 tests, including real HTTP against
stub gateways for both wire formats, because the risky part of an adapter is the wire format and a mock
of your own assumptions cannot tell you the assumption was wrong.

Verified end to end against a stub gateway: a response containing `"verdict": "safe to merge"` had the
verdict stripped and reported, and a malformed check was dropped and counted. Both degradation paths
were exercised too - no route, and a dead gateway - and each publishes the deterministic report with
the reason recorded, exit 0.

Not yet built: the issue sink, and any plugin or registry layer. That last one waits for a second real
task, because two instances is when the shape becomes knowable and one is when it becomes guesswork.
