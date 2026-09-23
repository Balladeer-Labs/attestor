# Balladeer attestor

This repository holds the GitHub Actions workflow, and the small program it runs, that
Balladeer uses inside your repository's CI. It is public so that anyone can read, and
rebuild, exactly what runs there.

## What this is

Balladeer lets a software team agree, in plain words, on behaviors that must keep
working, and then checks them on every change in the team's own CI, so that coding agents
and people don't quietly break them.

When a team sets up Balladeer, a small caller workflow is added to their repository. That
caller uses the reusable workflow in this repository, which runs each agreed behavior's
check against the commit on your own GitHub runner and reports the outcome to Balladeer.
Your source code, tests, and test output stay on the runner. Balladeer receives outcomes,
counts, identifiers, and SHA-256 digests.

This repository contains:

- the reusable workflow,
  [`.github/workflows/continuity-attestor.yml`](.github/workflows/continuity-attestor.yml);
- the TypeScript source of the runner, the program that executes each check
  ([`packages/continuity-runner`](packages/continuity-runner));
- the prebuilt JavaScript your CI actually executes
  ([`release/continuity-runner`](release/continuity-runner)), which rebuilds byte for byte
  from that source; and
- the release checks and the policy documents listed at the end of this page.

It does not contain Balladeer's service or database, any team's promises, verifiers,
fixtures or results, or any credentials. The runner uses only Node.js built-in modules:
it has no third-party runtime dependencies and makes no network requests of its own.

### Terms used on this page

- **Promise:** a behavior your team agreed must keep working, written in plain words with
  examples of passing and failing cases. A named person approves its meaning in Balladeer.
- **Verifier:** the command in your repository that checks one promise, such as a test
  file or a script. It is written by your team (or your coding agent) and runs only on
  your runner.
- **Promise folder:** `.continuity/promises/<promise-id>/`, which holds a promise's
  verifier, fixtures, and helper scripts. The promise's sealed package,
  `.continuity/packages/<promise-id>.json`, lists every file in that folder with its
  SHA-256 digest. If a file in the folder is added, removed, or changed, the run is
  reported as `custody-invalid` instead of being trusted. *Custody* is this guarantee:
  what ran is byte for byte what was approved.
- **Qualification:** a test of the verifier itself, so that a verifier that cannot tell
  working behavior from broken behavior is not trusted. It has four controls: **good**
  (the verifier passes against a known-good setup), **bad** (it reports a failure against
  a known-broken setup), **refactor** (it still passes after a behavior-preserving
  change), and **tamper** (the runner alters a locked verifier file and confirms the run
  is caught as `custody-invalid`). A verifier qualifies only when all four come out that
  way.

## What runs in your CI

The caller workflow in your repository looks like this:

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

- `RELEASE_SHA` is the full 40-character commit SHA of a release of this repository. If
  the workflow is referenced by a branch or tag, or runs from any repository other than
  `Balladeer-Labs/attestor`, the jobs that execute the runner fail before running it.
- `contents: read` lets the verification jobs check out your commit.
- `id-token: write` lets the registration and publishing jobs request a GitHub-signed
  identity token (OIDC) for the fixed audience `https://attest.balladeer.ai`. Balladeer's
  service uses that token to confirm which repository, caller workflow, and attestor
  commit produced a result, and refuses results that do not match what was registered.
- `workspace_locator` is a non-secret identifier that routes the run to your Balladeer
  workspace. It authorizes nothing on its own.
- `default_branch` names the branch whose pushes run qualification.

### The jobs

Permissions are set per job. The jobs that check out your code cannot request a token, and
the jobs that can request a token never check out your code and handle only closed JSON
documents.

| Job | Checks out your code | Can request an OIDC token | What it does |
| --- | --- | --- | --- |
| `register` | No | Yes | Identifies the run to Balladeer's service and receives the list of active promises (promise IDs and sealed-package digests). |
| `verify` | Yes | No | Runs every active promise's verifier against the commit. |
| `merge` | No | No | Combines the `verify` results into one document. |
| `publish` | No | Yes | Sends that closed result document to Balladeer. |
| `qualify-controls` | Yes | No | On pushes to your default branch, when a qualification file is present, runs the four qualification controls. |
| `qualify-publish` | No | Yes | Sends the closed qualification receipts to Balladeer. |
| `qualify-gate` | No | No | Fails the run if a qualification control could not reach a verdict, after that receipt has been sent. |

Balladeer's service may suggest splitting `verify` across parallel jobs. The suggestion is
bounded: at most 256 jobs, each with a time limit of at most 45 minutes (30 by default).
An out-of-range job count falls back to a single job. Every `verify` job still checks the
digests of the whole promise list and runs only its own share, so the suggestion cannot
change which promises are checked. A promise whose `verify` job never reported is
recorded as `errored` with the reason `shard_failed`.

### How the runner is chosen

Each job that executes the runner identifies it from GitHub's own record of which reusable
workflow is running: `job.workflow_repository`, `job.workflow_ref`, `job.workflow_sha`,
and `job.workflow_file_path`. It requires the repository to be `Balladeer-Labs/attestor`
and the reference to be a commit SHA, checks out this repository at exactly that SHA,
confirms the checkout's `HEAD`, moves it into the runner's temporary directory outside
your checkout, makes it read-only, and only then executes
`release/continuity-runner/cli.js`. No response from Balladeer's service, caller input,
repository variable, branch, or tag can choose what code runs. Nothing is installed or
compiled in your CI.

### Environments and limits

- **Supported:** GitHub.com, including GitHub Enterprise Cloud. **Not supported:** GitHub
  Enterprise Server, which does not provide the `job.workflow_*` values the workflow
  depends on.
- Every job runs on a GitHub-hosted `ubuntu-24.04` runner and has an explicit time limit.
  Jobs that execute the runner use Node.js 22.18.0.
- Every third-party action is pinned to a full commit SHA.
- Within a job, promises and controls run one at a time, because verifiers may share
  databases, queues, ports, or other fixtures. Each verifier command has its own time
  limit: 2 minutes unless its package sets one, and never more than 10 minutes.
- Every request the workflow sends to Balladeer's service or to GitHub's token service
  has a 10-second connection timeout and a 30-second overall limit.

The workflow also accepts two inputs that default to `false`, `verify_replay_boundaries`
and `verify_pr_qualification_boundary`. They exist for maintainers' controlled test runs
and are described in [RELEASE-POLICY.md](RELEASE-POLICY.md). Neither can change what code
runs, where requests go, or the token audience.

## What Balladeer receives, and what stays on your runner

Balladeer's service receives:

- a GitHub-signed OIDC token with each request;
- identifiers for the run: your workspace locator, the repository name and its numeric
  repository and owner IDs, the Git ref, the calling workflow's name, ref, and SHA, the
  event, the run ID and attempt, and the base, head, and target commit SHAs;
- one result per active promise, with exactly 21 fields: identifiers (schema and runner
  versions, promise ID, package digest, commit SHA, and control), the outcome and its
  reason code, exit code, a signal name from a fixed list, duration, example counts,
  start and finish times, the verdict format used, a custody flag, and SHA-256 digests of
  the verifier's standard output and standard error, its verdict document, and the result
  itself; and
- for qualification, a receipt containing identifiers, digests, and the outcome of each
  control.

Every value is an identifier, a timestamp, a bounded number, a value from a fixed list,
or a SHA-256 digest. There is no free-text field.

What never leaves your runner: source code, verifier programs, fixtures, file paths, test
names, failure messages, the verifier's standard output and standard error, and verdict
documents. The verifier's output is shown to you in your own job log instead.

Balladeer's service sends back a run identifier, a one-time challenge, the frozen list of
active promises, and optional, bounded advice about splitting verification and about
qualifications already completed. None of it can select code, a network destination, or
a token audience.

The workflow's own requests go only to `https://attest.balladeer.ai` and to GitHub's
OIDC, checkout, and artifact services. That address and the token audience are constants
in the workflow, not inputs, variables, or secrets. Verifiers run with a minimal
environment that contains no GitHub or OIDC credentials. The runner is not a sandbox,
though: a verifier is ordinary code in your job and has whatever network access GitHub and
your settings allow.

The exact field lists are in [TRUST-BOUNDARY.md](TRUST-BOUNDARY.md), and the security
design is in [SECURITY.md](SECURITY.md).

## Verifying a release yourself

```sh
git clone https://github.com/Balladeer-Labs/attestor.git
cd attestor
git checkout RELEASE_SHA   # the full SHA in your caller workflow
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm run check-release
```

This needs Node.js 22 and pnpm (the exact pnpm version is in `package.json`). Development
dependencies are limited to TypeScript and Node's type definitions (three packages in the
lockfile), installed with install scripts disabled.

`pnpm run check-release`:

- compiles the TypeScript source into a temporary directory and confirms the result is
  byte-for-byte identical to the committed `release/continuity-runner`;
- confirms the fixed address and token audience, full-SHA action pins, per-job
  permissions and time limits, the exact list of files in the repository, and the absence
  of secrets and private paths;
- runs the runner against synthetic test promises; and
- exercises the optional self-check steps against a local stand-in for `curl`.

To rebuild the committed runner in place instead, run `pnpm run build:release`;
`git status` should then show no changes. When your caller moves to a new release,
`git diff OLD_SHA NEW_SHA` shows exactly what changed.

This repository currently has one maintainer, so release commits have not had review by
a second person. [RELEASE-POLICY.md](RELEASE-POLICY.md) states exactly what its branch
protection does and does not prove.

## Reading a check result

Every active promise gets exactly one outcome per run:

| Outcome | Meaning | Annotation |
| --- | --- | --- |
| `pass` | The verifier ran and the behavior held. | notice |
| `refuted` | The verifier ran and reported that the behavior no longer holds. This is a caught regression. | error |
| `errored` | No verdict was possible: a crash, a command that could not start, a missing or malformed verdict document, a suite that ran no examples, or a `verify` job that never reported. | warning |
| `timed_out` | The verifier exceeded its time limit. | warning |
| `canceled` | The run was stopped from outside, for example by a cancelled workflow run. | warning |
| `custody-invalid` | The sealed package or a file in the promise folder is missing, ambiguous, or differs from what was approved, so nothing from this run can be trusted. It is not a statement about your code, but someone has to act on it. | error |

Every outcome other than `pass` and `refuted` also carries a reason code, such as
`nonzero_exit`, `result_missing`, `no_examples_ran`, `timeout`, or `shard_failed`.

The check is red for anything other than `pass`, and its log says which kind of red it is:
"This is a caught regression" for `refuted`, and "This is not a regression; the check
could not run" for `errored` and `timed_out`. The workflow reports it as an advisory
check; whether it blocks merging is up to your branch protection rules. A repository with
no active promises yet gets a passing check that says so.

The job log shows each verifier's own standard output and standard error, one line at a
time behind a `[balladeer]` prefix, then one sentence per promise naming the promise, the
control, the outcome, its reason code, and the agreed observable behavior. The same lines
appear as GitHub annotations, and a job-summary table adds each promise's owner and a
link to the promise in Balladeer, when the package records them. All of this stays in
your job log; Balladeer never receives it.

A promise with a broken package is reported as `custody-invalid` on its own, without
running its verifier. Every other promise in the same run still runs and reports.

If a qualification control cannot reach a verdict, its receipt is still sent, so Balladeer
records the verifier as not qualified and why. The `qualify-gate` job then fails, so a
crashed control never leaves a green run behind.

## Writing a verifier (reference)

This section is for people and coding agents writing verifiers. The package format and
its validation are defined in
[`packages/continuity-runner/src/index.ts`](packages/continuity-runner/src/index.ts).

### Where files go

| Path | Contents |
| --- | --- |
| `.continuity/packages/<promise-id>.json` | The sealed package: the agreed meaning, the four verifier commands (`target`, `good`, `bad`, `refactor`), an optional `results` declaration, an `attribution` (the owner's name and the promise's page, shown in failing checks), and the list of locked files with their digests. |
| `.continuity/promises/<promise-id>/` | The promise folder: the verifier, its fixtures, and helper scripts. Every regular file must be listed in the package. Symbolic links and special files are refused. |
| `.continuity/qualification/<promise-id>.json` | Present when the promise needs qualifying. Removing it after qualification is optional. |

The verifier's entry point must be inside the promise folder. A verifier may import or
call application code and dependencies outside the folder: that code is the system under
test and is not covered by the digest lock. A helper that decides how the promise is
checked, rather than implementing the product being tested, belongs inside the folder.

There is no caller-supplied setup step. Any preparation a verifier needs is a script in
the promise folder, listed in the package as support material and called by the verifier.

### Preparation scripts and their outputs

This is the most common way a correct verifier ends up reporting `custody-invalid`. The
preparation script is locked: it lives in the promise folder and must stay byte-identical
to its recorded digest. What it produces must not be. Installed dependencies,
package-manager and build caches, compiled output, virtual environments, regenerated
lockfiles, and scratch files all belong outside `.continuity/promises/<promise-id>/`: in
the repository working directory, a temporary directory, or the runner's scratch space.
The runner re-checks the exact contents of the promise folder immediately before every
control and before the target run, so a single generated file inside it makes the run
`custody-invalid` even though nothing a person wrote has changed.

### Commands

Each command has an `executable` and `args`, plus an optional `cwd` (which must stay
inside the repository) and an optional `timeoutMs` (1 to 600,000; the default is
120,000). The runner starts the command directly, without a shell, so environment
variables are not expanded inside arguments. The command receives only `PATH`, `HOME`,
`TMPDIR`, `TMP`, `TEMP`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, and `SYSTEMROOT` from the
job's environment, plus `BALLADEER_RESULT_PATH` when the package uses the `native`
format below. The package cannot pass through any other variable.

### How a verifier reports its verdict

An exit status alone cannot tell a failed assertion from a crash: Node.js, Python, and
Ruby all exit 1 for both an uncaught import error and a failed assertion, and vitest and
jest exit 1 for both a configuration error and a failing test. A package therefore
declares its verdict format in an optional `results` member beside `verifier`:

```jsonc
{ "results": { "protocol": "native" } }
{ "results": { "protocol": "junit", "file": "reports/junit.xml" } }
```

**`native`:** the command writes this document, and nothing else, at the absolute path in
`BALLADEER_RESULT_PATH`:

```json
{ "schemaVersion": "continuity-verifier-result/v1",
  "outcome": "passed",
  "examples": { "total": 12, "refuted": 0, "errored": 0 } }
```

`outcome` is `passed`, `refuted`, or `errored`. `examples.skipped` is optional; skipped
examples did not run. No Balladeer library or network access is needed. The runner
chooses the path itself, outside your repository, so the document is never inside the
promise folder and cannot be left over from an earlier run.

**`junit`:** your ordinary test runner writes JUnit XML at the declared path. For example,
`vitest --reporter=junit --outputFile=reports/junit.xml`, `pytest --junit-xml=...`,
`jest --reporters=jest-junit`, `go-junit-report`, and
`rspec --format RspecJunitFormatter --out ...` all produce it. Because there is no shell,
write the same literal path in `results.file` and in the command's arguments, relative
to the command's working directory; the package refuses to seal if they disagree. The
path must be outside `.continuity/promises/`. The runner reads only four numbers from the
report (`tests`, `failures`, `errors`, and `skipped`), never test names, messages, or
element text. It takes totals from the `<testsuites>` root when the root carries them and
otherwise sums the child `<testsuite>` elements. When the root omits `skipped`, as
jest-junit's does, the runner sums `skipped` from the children, so a suite that skipped
every example is reported as `errored` / `no_examples_ran`, never as a pass.

For both formats the runner deletes the document before the command starts and after
reading it, and records its SHA-256 digest. A declared JUnit path is also refused if it
escapes the checkout or if it, or its parent directory, is a symbolic link. The runner
then decides:

- any errored example, or a document over 16 MiB, gives `errored`;
- a document that says `passed` from a command that exited non-zero gives `errored`
  (`result_disagrees_exit`), while a refutation from a command that exited 0 stays
  `refuted`;
- zero examples run gives `errored` (`no_examples_ran`).

**No `results` member** means exit code only: exit 0 is `pass` and anything else is
`errored`. Such a package can never report `refuted`, so it can never qualify.

Adding `results` to an existing package changes its package digest. The promise then
reports `custody-invalid` until the re-sealed package is activated in Balladeer, so plan
for each migrating promise to go without a verdict for that period.

### Keeping the agreed wording intact

A package's promise may include `oneSentenceOutcome` (up to 160 characters) and
`saidWords` (up to 2,000 characters), and each passing, failing, or refactor example may
include its own `saidWords`. These fields are optional, and packages that omit them
remain valid. When present, they are part of the agreed meaning and are covered by the
digest its owner approved. Their text is kept exactly: removing a field, trimming a
quotation, or replacing it with a paraphrase changes the meaning, and the package no
longer matches the approved digest. That is never a valid fix for a runner that does not
recognize a field. Unknown fields and malformed values are refused.

Upgrading the pinned release does not change what was agreed. Qualification metadata,
however, is tied to the release it was issued for, so a promise qualified after an
upgrade uses metadata issued for the new pin; existing verifier code and fixtures carry
over. A package an older runner could not seal is sealed again, with its complete agreed
wording, by a runner that accepts it. An agreed digest is never changed to suit an older
runner.

## Reporting a vulnerability

Please report security issues privately. See [SECURITY.md](SECURITY.md).

## For maintainers and contributors

- [CLAUDE.md](CLAUDE.md): the rules for anyone, including coding agents, changing this
  repository.
- [SECURITY-REVIEW.md](SECURITY-REVIEW.md): the threat model and the re-test checklist
  each release candidate must pass.
- [RELEASE-POLICY.md](RELEASE-POLICY.md): how releases are published, supported,
  deprecated, revoked, and rolled back, and the maintainer-only test switches.
- [TRUST-BOUNDARY.md](TRUST-BOUNDARY.md): the exact information exchanged with Balladeer.

Before a change is merged, the same commands used to verify a release must pass, and the
diff of both the TypeScript source and the generated runner must be reviewed.

## License

Apache-2.0. See [LICENSE](LICENSE).
