# Security policy

This repository contains the GitHub Actions workflow and the runner program that
Balladeer's CI integration executes in your repository. It is public and holds no
secrets. Its security comes from an implementation anyone can audit plus GitHub-signed
identity, not from keeping the code private. [README.md](README.md) explains what
Balladeer is and what the workflow does.

## Reporting a vulnerability

Please do not report a suspected vulnerability in a public issue, discussion, or pull
request. Report it privately through GitHub's private vulnerability reporting for this
repository: <https://github.com/Balladeer-Labs/attestor/security/advisories/new>.

A useful report includes:

- the commit SHA you tested;
- which protection described below you believe is broken; and
- a minimal reproduction, ideally in a synthetic repository.

Please do not include proprietary source code, credentials, or unredacted CI logs from a
real repository. A synthetic reproduction is enough.

## Scope

In scope:

- the reusable workflow, `.github/workflows/continuity-attestor.yml`;
- the runner source in `packages/continuity-runner` and the prebuilt runner in
  `release/continuity-runner`; and
- the release checks in `scripts/`.

Examples of what we want to hear about: anything other than GitHub's own workflow
identity choosing the code that runs; a job that holds a token being able to read your
source, or a job that reads your source being able to obtain a token; data beyond the
documented fields reaching Balladeer; verifier output that can forge a GitHub workflow
command; a changed verifier or fixture that is not reported as `custody-invalid`; and a
prebuilt runner that does not match its source.

Reports about Balladeer's hosted service or the Balladeer CLI are also welcome through
the same private channel.

Two limits, described below, are documented rather than vulnerabilities in themselves:
the runner is not a sandbox against a deliberately malicious verifier in your own
repository, and GitHub Enterprise Server is not supported. A report showing that either
limit reaches further than documented is in scope.

## Supported versions

Your repository runs the release named by the full commit SHA in its caller workflow.
Released commits are never rewritten. Every fix, including a rollback, ships as a new
release commit with a new SHA.

Balladeer's service, not this repository, holds the list of release commits and the
standing of each:

- **Supported:** accepted for new setups and for publishing results.
- **Deprecated:** existing setups keep working for a limited time, and their owners are
  asked to approve an upgrade. New setups must use a supported release.
- **Revoked:** new runs are refused because the release is unsafe or its guarantees no
  longer hold. Results it produced earlier remain on record, marked with the release that
  produced them.

Balladeer never changes the SHA your repository runs without an explicit upgrade.
[RELEASE-POLICY.md](RELEASE-POLICY.md) describes how releases are published, upgraded,
rolled back, and revoked. Please report against the commit you are running or the latest
commit on `main`.

## What to expect after reporting

We will acknowledge your report and keep you updated while we investigate, including the
outcome. If the issue is confirmed, the fix ships as a new release commit, and affected
releases may be deprecated or revoked as described above.

## How the workflow protects your repository

The terms used here (promise, verifier, promise folder, custody, qualification) are
defined in [README.md](README.md#terms-used-on-this-page). The exact fields exchanged with
Balladeer are listed in [TRUST-BOUNDARY.md](TRUST-BOUNDARY.md).

### Separated jobs

The workflow has three deliberate boundaries:

1. `register` and the publishing jobs (`publish` and `qualify-publish`) can request a
   GitHub OIDC token but never check out your source.
2. `verify` and `qualify-controls` can read your source but have no permission to request
   a token. (`merge` and `qualify-gate` can do neither.)
3. The runner gives the token-holding jobs only normalized outcomes, reason codes from
   fixed lists, bounded example counts, and SHA-256 digests. It does not send paths,
   prompts, logs, raw standard output or standard error, verdict documents, fixtures, or
   source to Balladeer.

Balladeer's service checks the token's repository identity, caller workflow, called
workflow, and exact called-workflow SHA against what was registered for your repository.

### What code runs

The runner is selected solely from GitHub's identity for the running reusable workflow:
`job.workflow_repository`, `job.workflow_ref`, `job.workflow_sha`, and
`job.workflow_file_path`. The workflow refuses a branch or tag reference, checks out its
own repository at its own workflow SHA into a run-specific staging path, verifies `HEAD`,
then moves the checkout into `RUNNER_TEMP` and makes it read-only before any of your code
runs. A response from Balladeer's service cannot choose the repository, revision, or
executable.

GitHub Enterprise Server does not provide these workflow-identity properties, so it is
not supported.

### Verifier processes

The runner starts your verifiers with a minimal environment: an allow-list of ten
standard variables (such as `PATH`, `HOME`, `TMPDIR`, locale, and time zone), plus
`BALLADEER_RESULT_PATH` when the package uses the `native` verdict format. Verifiers do
not inherit GitHub tokens, OIDC credentials, or runner metadata.

The runner is not a sandbox against a deliberately malicious process on the same GitHub
runner. Custody (the guarantee that what ran is byte for byte what was approved) is
designed to catch accidental changes and ordinary tampering, including by coding agents.
You remain responsible for your verifier code and your GitHub runner policy.

### Digest-locked promise folders

There is no caller-supplied setup command. Verifier preparation lives in the promise
folder, `.continuity/promises/<promise-id>/`. The package must list every regular file in
that folder, symbolic links and special files are refused, and every listed byte is
digest-checked before sealing, before qualification, and before execution. The verifier
command must point to a verifier inside the same folder.

Preparation scripts are therefore locked, but their outputs must not be. The exact
contents of the promise folder are re-checked immediately before every control and
before the target run, so any file a preparation step creates inside the folder makes the
run `custody-invalid` rather than failing it. Installed dependencies, package-manager and
build caches, compiled output, virtual environments, regenerated lockfiles, and scratch
files belong outside `.continuity/promises/<promise-id>/`. This is a deliberate
consequence of the lock, not a limitation to work around by removing files from the
package.

A verifier can import or call application code outside its promise folder, because that
code is the system under test. Those files are not covered by custody. A helper that
decides how the promise is checked, rather than implementing the product being tested,
belongs inside the promise folder, listed as support material.

### The verdict document stays on your runner

A verifier reports whether the behavior held, was refuted, or could not be decided by
writing a document the runner reads: a small JSON document at the absolute path in
`BALLADEER_RESULT_PATH` (`native`), or its ordinary JUnit report at the path the package
declares (`junit`). Like standard output and standard error, its bytes stay on your
runner.

The runner reads one outcome value and a few bounded integers out of that document and
records the SHA-256 digest of its bytes. It never reads an element's text, a failure
message, or a test name, and it uses no XML or other parsing library to do so, which is
why the runner still imports only Node.js built-in modules. The document itself is never
published, never included in a request as content, and never echoed as a workflow
command.

The path is constrained rather than trusted. The runner chooses the `native` path itself,
outside the repository, so nothing is written into the promise folder. A declared `junit`
path is resolved against the command's own working directory, refused if it escapes the
checkout or if it or its parent directory is a symbolic link, refused at sealing time if
it lies under `.continuity/promises/`, and deleted both before the process starts and
after it is read. Deleting it first is what makes absence meaningful: a document present
after the process exits was written by this run, not left over from the last one. A file
larger than 16 MiB is `errored`, never truncated into a verdict.

### Verifier output goes to your own job log

The runner has two output channels, and they never mix. Standard output carries only the
closed result JSON, which the workflow uploads for the publishing job. Standard error
carries what a person reads: each verifier's own standard output and standard error, one
sentence per promise naming the promise, the control, the outcome, and the agreed
observable behavior, a GitHub annotation, and a job-summary table.

That explanation reaches only the customer's own GitHub job log, meaning the Actions log
of the repository that called the workflow. It is never added to a result, a digest, or
any request to Balladeer, and Balladeer never receives it. The published results contain
only normalized outcomes and SHA-256 digests over the raw bytes.

Echoed text is treated as untrusted input to that log: verifier output, package text
written in your repository, and promise IDs from Balladeer's list of active promises.
GitHub Actions interprets workflow commands such as `::error::` in a job's output, so
every echoed line is stripped of control characters, capped in length, and printed behind
a fixed `[balladeer]` prefix. Echoed text can never begin a line, and so cannot forge an
annotation, a job-summary write, or any other workflow command. The echo stops after
1 MiB of log per stream, counted in bytes written to the log so that many short lines
cannot multiply through the prefix. A verifier that writes more than 1 MiB to either
stream is stopped and reported as `errored` with the reason `output_limit`.

The runner prints nothing from a response by Balladeer's service except bounded promise
IDs. Separately, if registration is refused, the workflow prints the HTTP status and at
most the first 4,096 bytes of the service's error response, so you can see why.

### Fixed destinations

Requests the workflow itself makes go only to `https://attest.balladeer.ai`, and OIDC
tokens are requested only for the audience `https://attest.balladeer.ai`. Neither value
is, or may become, a workflow input, repository variable, or secret: that would let a
caller redirect a token or results intended for Balladeer.

The workflow also uses GitHub's checkout, OIDC, and artifact services. Your verifier
processes may reach other network destinations that you and GitHub permit. That activity
is outside the workflow's own requests and is not data sent to Balladeer.

### Release discipline

Every third-party action is pinned to a full commit SHA. The prebuilt runner must rebuild
byte for byte from the checked-in TypeScript. The release check allows only a fixed list
of public files and rejects common secret formats, private filesystem paths, and known
private identifiers. Private vulnerability reporting, secret scanning, and push protection
are enabled on this repository.

A change to the address, token audience, workflow, runner, or release policy is
security-sensitive. It reaches `main` only through a pull request that passes the release
check, produces a new commit SHA, and is offered to repositories only after an explicit
update to Balladeer's release registry. See [RELEASE-POLICY.md](RELEASE-POLICY.md).
