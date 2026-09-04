# Balladeer attestor

This is the deliberately small, public trust anchor for Balladeer's GitHub CI
integration. Its permanent repository identity is `Balladeer-Labs/attestor`.

It contains:

- the reusable `continuity-attestor.yml` workflow;
- the auditable source for the continuity runner;
- the prebuilt, source-reproducible runner customer CI executes; and
- the checks and policy documents required to release that trust anchor safely.

It does **not** contain Balladeer's control plane or database, customer repositories,
customer promises, fixtures, verifier programs or output, credentials, or deployment
history. The CI origin and GitHub OIDC audience are hard-coded into the released
workflow; callers cannot redirect its identity token or results.

See [TRUST-BOUNDARY.md](TRUST-BOUNDARY.md) for the exact information exchange,
[SECURITY-REVIEW.md](SECURITY-REVIEW.md) for the original trust failure and mandatory
re-test gates, and [RELEASE-POLICY.md](RELEASE-POLICY.md) for upgrade, rollback, and
revocation rules. Coding agents must read [CLAUDE.md](CLAUDE.md) before making changes.

## How a customer uses a release

Balladeer generates a small caller workflow in the customer's repository. Its `uses`
reference is pinned to the full commit SHA of this repository:

```yaml
jobs:
  balladeer:
    permissions:
      contents: read
      id-token: write
    uses: Balladeer-Labs/attestor/.github/workflows/continuity-attestor.yml@RELEASE_SHA
    with:
      workspace_locator: ${{ vars.BALLADEER_WORKSPACE_LOCATOR }}
      default_branch: main
```

During a run, GitHub binds the caller and called-workflow identity into signed OIDC
claims. The verification job can read the customer's checked-out commit but cannot mint
OIDC. Token-bearing jobs never check out customer source and receive only closed JSON
results. Balladeer's service accepts evidence only when the signed identities and exact
attestor SHA match the enrollment.

The workflow uses GitHub's `job.workflow_repository`, `job.workflow_ref`,
`job.workflow_sha`, and `job.workflow_file_path` contexts to identify the reusable
workflow that is actually running. It checks out that repository at that SHA, requires
the workflow ref to be SHA-pinned, verifies the checkout's `HEAD`, and only then executes
`release/continuity-runner/cli.js`. The control-plane response cannot select executable
code. The workflow does not install dependencies for or compile the attestor inside
customer CI; the committed JavaScript is reproduced from reviewed TypeScript on every
attestor pull request.

This v0 integration supports GitHub.com, including Enterprise Cloud. GitHub Enterprise
Server does not currently expose these `job.workflow_*` identity properties and is not a
supported execution environment.

There is no caller-supplied setup hook. Any preparation needed by a verifier belongs in
the promise-owned `.continuity/promises/<promise-id>/` tree: the verifier entrypoint
may invoke helpers declared as support material. Every regular file in that tree must be declared and digest-locked by the
acceptance package. The verifier may still exercise application code and dependencies
outside that tree as its system under test; those external files are not covered by the
verifier-custody claim.

Preparation scripts and their outputs are governed differently, and getting this backwards
is the most common way to make a correct verifier report `custody-invalid`. The script
itself must live inside `.continuity/promises/<promise-id>/`, be declared as support
material, and stay byte-identical to its recorded digest. Anything the script produces must
be written outside that tree: installed dependencies, package-manager and build caches,
compiled output, virtual environments, lockfiles it regenerates, and scratch files.
The runner re-checks exact closure over the promise tree immediately before every control
and before the target run, so a single generated file appearing inside it makes that run
custody-invalid even though nothing a human authored has changed. Write to the repository
working directory, a temporary directory, or the runner's own scratch space instead.

Controls and promises execute serially by default because customer verifiers may share
databases, queues, ports, or other mutable fixtures. Individual verifier processes remain
time-bounded, and the surrounding GitHub jobs have explicit wall-clock limits.

## How a verifier reports its verdict

Exit status alone cannot separate a refusal from a crash. Node, Ruby and Python all exit 1
for an uncaught import error and 1 for a failed assertion; vitest and jest exit 1 for a
config crash and 1 for a failing test. A package therefore declares how its verdict is
produced, in an optional `results` member beside `verifier`:

```jsonc
{ "results": { "protocol": "native" } }
{ "results": { "protocol": "junit", "file": "reports/junit.xml" } }
```

`native` means the command writes this document, and nothing else, at the absolute path
the runner exports as `BALLADEER_RESULT_PATH`:

```json
{ "schemaVersion": "continuity-verifier-result/v1",
  "outcome": "passed",
  "examples": { "total": 12, "refuted": 0, "errored": 0 } }
```

That is five lines in any language, with no Balladeer dependency, no import, and no
network. `examples.skipped` is optional; examples that were skipped did not run. The runner
chooses the path itself, outside your repository, so the document is never a file inside
the digest-locked promise tree and can never be replayed from an earlier run.

`junit` means your ordinary test runner writes JUnit XML at the declared path.
`vitest --reporter=junit --outputFile=reports/junit.xml`, `pytest --junit-xml=...`,
`jest --reporters=jest-junit`, `go-junit-report`, and
`rspec --format RspecJunitFormatter --out ...` all satisfy it with a flag. Because the
runner spawns the command with no shell, the path cannot be expanded from an environment
variable inside an argument: write the same literal path in `results.file` and in the
command's arguments, relative to the command's working directory, and the package refuses
to seal if they disagree. The path must be outside `.continuity/promises/`, since a report
written inside that tree would break exact material closure for the next control. The
runner reads four integers from it (`tests`, `failures`, `errors`, and `skipped`) and
nothing else: no test name, no failure message, no element text. Totals come from the
`<testsuites>` root when it carries them, and from the child `<testsuite>` elements
otherwise. `skipped` is the one count a root routinely omits (jest-junit writes it only on
the children), so when the root does not carry it the children are summed: a suite that
skipped every example reports `errored` / `no_examples_ran`, never a pass over nothing.

A package with no `results` member is exit-code-only. It reports `pass` on exit 0 and
`errored` on anything else, and it can never report `refuted`, so it can never qualify.
Silence degrades to Unknown, never to a false pass.

Adding `results` to an existing package changes its package digest, so the promise reports
`custody-invalid` against its frozen manifest until the owner activates the re-sealed
package in Balladeer. Plan that round trip: every migrating promise passes through Unknown.

## Reading a failing check

Every result carries exactly one outcome: `pass` (the verifier ran and the behavior held),
`refuted` (the verifier ran and reported an assertion failure), `errored` (no verdict was
possible: a crash, a spawn failure, a missing or malformed document, or a suite that ran no
examples), `timed_out`, `canceled` (an external SIGTERM or SIGINT, such as a cancelled CI
run), or `custody-invalid`. Everything but `pass` and `refuted` also carries a closed
`outcomeReason` naming which case it was. Only `refuted` is a caught regression, and the
check prints "this is not a regression; the check could not run" for `errored` and
`timed_out`. The check is red either way.

Two outcomes are annotated as GitHub errors, for different reasons. `refuted` is the caught
regression. `custody-invalid` is not a regression and never blames your code, but it is not
"the check could not run" either: digest-locked material changed, so no result from that run
can be trusted. `errored`, `timed_out` and `canceled` are annotated as warnings, so a
verifier that crashed never looks in the GitHub UI like a behavior that broke.

The runner writes each verifier's own stdout and stderr into the GitHub job log, one line
at a time behind a `[balladeer]` prefix, followed by a sentence per promise naming the
promise, the control, the outcome, its reason code, and the approved observable outcome.
The same lines appear as GitHub annotations and as a job-summary table. All of it stays in
the customer's own run: Balladeer still receives only normalized outcomes, counts and
SHA-256 digests. See [SECURITY.md](SECURITY.md) for the exact boundary.

A published result carries exactly these 21 fields and nothing else: `schemaVersion`
(`continuity-result/v2`), `runnerVersion`, `promiseId`, `packageDigest`, `sourceSha`,
`control`, `outcome`, `outcomeReason`, `exitCode`, `signal`, `durationMs`, `stdoutDigest`,
`stderrDigest`, `resultProtocol`, `resultDocumentDigest`, `exampleTotal`, `exampleRefuted`,
`startedAt`, `completedAt`, `custody`, and `resultDigest`. The sealed package keeps its own
`continuity-package/v1` schema and its own digest, so this result version costs no customer
a re-seal.

`signal` is mapped onto a closed list before it is published, so no operating-system string
crosses the wire: `SIGABRT`, `SIGBUS`, `SIGFPE`, `SIGHUP`, `SIGILL`, `SIGINT`, `SIGKILL`,
`SIGPIPE`, `SIGQUIT`, `SIGSEGV`, `SIGTERM`, `SIGTRAP`, `SIGXCPU`, `SIGXFSZ`, and `other` for
everything else. The resource-limit names are worth keeping apart: a container that
exhausts its CPU budget is killed with `SIGXCPU` and one that hits a file-size limit with
`SIGXFSZ`, and the repair for each differs from the repair for an unknown signal. All of
them are `errored` / `signal_killed`, so the name changes only what the reason line can
say, never the verdict.

Every promise in the frozen manifest produces exactly one result. A promise whose sealed
package is missing, re-sealed since activation, ambiguous, or unreadable is reported as
`custody-invalid` on its own, with no verifier run, while every other promise in the same
manifest still executes and publishes. One broken package therefore never blanks the
catalog.

A qualification receipt is published even when a control could not decide, so the binding is
recorded as unqualified with the reason. A separate job then fails the run, after that
receipt is sent: a crashed control must never leave a green job behind.

The receipt carries `resultProtocol` beside its four controls, naming how that package's
verdicts were produced (`native`, `junit`, or `exit-code-only`). Each of `good`, `bad` and
`refactor` publishes exactly `outcome`, `outcomeReason` and `resultDigest`, with
`outcomeReason` explicitly `null` on a control that reached a verdict; `tamper` publishes
`outcome` and `resultDigest`. Nothing else about a control leaves your runner.

Never enroll a mutable branch or tag. Tags may make a release easier for people to find,
but customer callers pin the full 40-character commit SHA.

## Developing and validating a release

Development dependencies exist only to type-check source and reproduce the committed
runner in this public repository:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm run build:release
pnpm run check-release
```

After `build:release`, review both the source and generated runner diff. The deterministic
release check verifies the fixed endpoint/audience, immutable action pins, exact public
file inventory, mandatory handoff safeguards, secret and private-path absence, and
byte-for-byte runner reproducibility. These deterministic checks do not replace the
independent review or cross-repository canaries in
[SECURITY-REVIEW.md](SECURITY-REVIEW.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
