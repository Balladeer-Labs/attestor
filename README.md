# Balladeer attestor

This is the deliberately small, public trust anchor for Balladeer's GitHub CI
integration. Its permanent repository identity is `Balladeer-Labs/attestor`.

It contains:

- the reusable `continuity-attestor.yml` workflow;
- the auditable source for the continuity runner;
- the prebuilt, source-reproducible runner customer CI executes; and
- the checks and policy documents required to release that trust anchor safely.

It does **not** contain Balladeer's control plane or database, customer repositories,
customer acceptance envelopes, fixtures, verifier programs or output, credentials, or
deployment history. The CI origin and GitHub OIDC audience are hard-coded into the
released workflow; callers cannot redirect its identity token or results.

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
the envelope-owned `.continuity/envelopes/<envelope-id>/` tree: the verifier entrypoint
may invoke helpers declared as support material. Every regular file in that tree must be declared and digest-locked by the
acceptance package. The verifier may still exercise application code and dependencies
outside that tree as its system under test; those external files are not covered by the
verifier-custody claim.

Preparation scripts and their outputs are governed differently, and getting this backwards
is the most common way to make a correct verifier report `custody-invalid`. The script
itself must live inside `.continuity/envelopes/<envelope-id>/`, be declared as support
material, and stay byte-identical to its recorded digest. Anything the script produces must
be written outside that tree: installed dependencies, package-manager and build caches,
compiled output, virtual environments, lockfiles it regenerates, and scratch files.
The runner re-checks exact closure over the envelope tree immediately before every control
and before the target run, so a single generated file appearing inside it makes that run
custody-invalid even though nothing a human authored has changed. Write to the repository
working directory, a temporary directory, or the runner's own scratch space instead.

Controls and envelopes execute serially by default because customer verifiers may share
databases, queues, ports, or other mutable fixtures. Individual verifier processes remain
time-bounded, and the surrounding GitHub jobs have explicit wall-clock limits.

## Reading a failing check

The runner writes each verifier's own stdout and stderr into the GitHub job log, one line
at a time behind a `[balladeer]` prefix, followed by a sentence per envelope naming the
envelope, the control, the outcome, and the approved observable outcome. The same lines
appear as GitHub annotations and as a job-summary table. All of it stays in the customer's
own run: Balladeer still receives only normalized outcomes and SHA-256 digests. See
[SECURITY.md](SECURITY.md) for the exact boundary.

Every envelope in the frozen manifest produces exactly one result. An envelope whose sealed
package is missing, re-sealed since activation, ambiguous, or unreadable is reported as
`custody-invalid` on its own, with no verifier run, while every other envelope in the same
manifest still executes and publishes. One broken package therefore never blanks the
catalog.

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
