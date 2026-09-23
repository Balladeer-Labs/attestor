# Security review

This document records the threat model behind the attestor workflow and runner, the
design decision that most shapes them, and the checks a commit must pass before it is
treated as a release. Every item applies to the exact commit under review: checking one
off requires current evidence for that commit, not for an earlier one.

[README.md](README.md) explains what the workflow does, [SECURITY.md](SECURITY.md)
describes its protections, and [TRUST-BOUNDARY.md](TRUST-BOUNDARY.md) lists the exact
information exchanged with Balladeer's service.

## Threat model

The workflow runs inside the calling repository's GitHub Actions, next to that
repository's checked-out source. The review is organized around these threats:

- **Choosing what code runs.** A wrong or compromised response from Balladeer's service,
  a caller input, a repository variable, a branch, or a tag must never decide which
  executable runs beside the calling repository's source.
- **Redirecting identity or results.** A caller must not be able to send an OIDC token
  minted for Balladeer, or the results, to any other destination or audience.
- **Moving source or output off the runner.** Only the closed, documented fields may reach
  Balladeer. Source, fixtures, verifier programs, file paths, and raw output stay on the
  runner.
- **Changing what a verifier checks.** Accidental edits and ordinary tampering, including
  by coding agents, to a promise's verifier, fixtures, or helper scripts must be reported
  as `custody-invalid` rather than trusted.
- **Forging workflow commands.** Verifier output echoed to the job log must never be
  interpreted by GitHub as a workflow command or annotation.
- **Misreporting a crash.** A verifier that cannot produce a verdict must never be
  reported as a pass or as a refutation.

Two limits are documented rather than defended: the runner is not a sandbox against a
deliberately malicious verifier in the calling repository, and GitHub Enterprise Server,
which lacks the required workflow-identity properties, is not supported.

## Design note: how the executable is selected

In an early design, the calling repository's workflow pinned the reusable workflow, but
the registration response selected an attestor repository and SHA that a later
source-reading job checked out and executed. The pin protected the workflow YAML, not the
executable. If that response were wrong or compromised, CI could have executed different
code beside the checked-out source.

The current design takes executable identity only from GitHub's own `job.workflow_*`
context. Each source-reading job requires `Balladeer-Labs/attestor`, the exact reusable
workflow path, an immutable workflow SHA, and a matching checkout `HEAD`. The checkout is
moved to `RUNNER_TEMP` and made read-only before any verifier runs. The registration
response cannot select a repository, revision, or executable, and there is no
caller-provided setup command.

The same flaw must not return under another name: a release URL, artifact, download
manifest, server response, caller input, variable, branch, tag, or fallback path cannot
decide what executable runs.

## Exact re-test categories

For the exact candidate SHA, review or exercise every applicable category:

- **Executable selection:** attempt to return a different repository, SHA, executable,
  or download location from registration; confirm none is consumed. Attempt caller
  overrides. Confirm the workflow fails closed for a mutable or mismatched workflow
  ref, unexpected repository or path, missing identity property, or mismatched checkout
  `HEAD`. Copied or local workflow variants must not authenticate as this attestor.
- **Fixed identity and egress:** confirm the service origin and OIDC audience occur
  exactly once as fixed workflow constants and cannot be redirected by inputs, variables,
  or secrets. Exercise a wrong audience and a wrong called-workflow identity; Balladeer's
  service must reject both.
- **Privilege and data isolation:** confirm only the registration and publishing jobs can
  mint OIDC, those jobs never check out the calling repository's source, and
  source-reading jobs cannot mint OIDC. Inspect uploaded artifacts and HTTP bodies to
  prove they contain only the closed schemas described in `TRUST-BOUNDARY.md`, never raw
  output or files.
- **Runner provenance:** reproduce `release/continuity-runner` byte-for-byte from source,
  confirm every third-party action is full-SHA pinned, confirm the exact Node and Ubuntu
  versions, and confirm the calling repository's CI performs no attestor install or
  compilation.
- **Verifier custody:** reject missing, extra, changed, symlinked, special, escaping, or
  duplicate promise material. Confirm verifier entry points stay inside the declared
  promise folder, all regular files in that folder are declared and digest-locked, and
  helpers that define the assertion cannot hide outside it. Product code used as the
  system under test may remain outside the custody claim.
- **Setup-hook poisoning:** confirm no free-form setup command or equivalent pre-verifier
  execution surface exists. Preparation that determines the assertion must be declared
  package material.
- **Bounded execution:** confirm controls and promises run serially within a job, verifier
  processes are time-bounded, every job has a wall-clock timeout, and every authored HTTP
  request has connection and total timeouts.
- **Job-log output:** confirm verifier standard output and standard error reach the
  calling repository's own job log and nothing else. Inspect the published artifact and
  HTTP bodies for echoed text; they must still carry only normalized outcomes and digests.
  Exercise a verifier that emits `::error::`, `::stop-commands::`, ANSI escapes, carriage
  returns, and more than 1 MiB on each stream: every line must appear behind the fixed
  prefix, no line may be parsed by GitHub as a workflow command, and the echo must stop at
  the byte bound while the digest still covers every byte. Confirm the runner prints
  nothing from a service response beyond bounded promise IDs.
- **Per-package isolation:** confirm one missing, re-sealed, ambiguous, or unreadable
  package yields exactly one `custody-invalid` result for that promise while every other
  promise still runs and publishes. Confirm the result count still equals the frozen
  manifest's promise count, that the `custody-invalid` result carries the digest the
  manifest expected, that no verifier ran for it, and that the check still fails when any
  result is not a pass. Isolation must never let a run execute a package the manifest did
  not name.
- **Crash versus refusal:** confirm a verifier that cannot produce a verdict is never
  reported as a pass and never as a refutation. Exercise, for the target run and for the
  known-bad control, a crash at import, a missing interpreter, a wall-clock timeout, a
  fatal signal, an output flood, a declared protocol that wrote no document, a truncated
  document, a document claiming a pass while the process exited non-zero, a suite that
  reported zero tests, and a suite that skipped every test. Each must be `errored` or
  `timed_out` with the reason code that names it, and the known-bad control's crash must
  leave the package unqualified. Exercise the skipped-suite case in jest-junit's shape as
  well, where the `<testsuites>` root carries the totals and only the child `<testsuite>`
  elements carry `skipped`: read from the root alone, that report looks like a green suite
  that exercised nothing. Confirm the result document is deleted before the process
  starts, so a report left by a previous run cannot be replayed as this run's verdict, and
  that a document path escaping the checkout, reached through a symbolic link, or reached
  through a symbolically linked parent directory is `custody-invalid` with nothing outside
  the checkout deleted. Confirm the document's text never reaches a published field, an
  annotation, or standard output, and that no XML or parsing library was added to read it.
  Confirm an exit-code-only package can still pass but can never claim a refutation, and
  that its receipt says so in `resultProtocol` rather than leaving the service to infer it.
- **Receipt wire agreement:** confirm the qualification receipt's exact key set, including
  `resultProtocol` and an explicit `null` `outcomeReason` on a control that reached a
  verdict, is what Balladeer's service accepts. A key this runner sends and the service
  refuses answers HTTP 400 on the calling repository's default branch, turns its check red
  for a reason outside that repository, and stores no receipt, so a fixture written on
  either side alone is not evidence: the check must run this release's own runner against
  the service itself.
- **Protocol binding and replay:** exercise a good run plus wrong repository or owner IDs,
  wrong caller ref or workflow, wrong target or source SHA, a stale or reused challenge,
  mismatched manifest or package digests, incomplete results, and a revoked attestor
  release. All negative cases must fail closed or record the documented unknown state.
- **Optional self-check switches:** confirm `verify_replay_boundaries` and
  `verify_pr_qualification_boundary` both default to off and grant no extra permissions,
  checkouts, destinations, or caller hooks. With replay checks on, a repeated target
  publication must conflict, an identical qualified receipt must be reported as replayed,
  and a receipt with one changed result digest must conflict, with no extra lifecycle
  event from the duplicates. With the pull-request probe on, qualification must be refused
  and no receipt stored or protection started; an HTTP 400 `invalid_request` alone does not
  show why the request was refused, so a schema or identity refusal must not count.
  After a controlled run, turn both switches off and confirm ordinary publication works
  and pull requests again skip qualification. `scripts/check-publisher-replay.mjs` tests
  the extracted shell offline; those are command-shape tests, not evidence about the
  service.
- **Agreed wording:** the package accepts only the optional `oneSentenceOutcome` (160
  characters) and `saidWords` (2,000 characters, also optional on each example), preserves
  present text exactly, and covers it with the package and semantic digests. Re-test the
  form without these fields, each field alone and together, Unicode and maximum lengths,
  malformed, empty, and oversized values, unknown keys, removed or changed wording under an
  old semantic digest, and a stale package digest after a semantic change.
- **Completion-aware qualification:** registration may return a bounded list of
  qualifications already completed. It is setup advice, not a verification manifest or
  evidence, and it cannot select code, a network destination, a workflow identity, or a
  subset of required verification. Re-test the prebuilt executable and extracted
  qualification-job shell for first setup, the next push without cleanup, a retry, empty
  and invalid advice, changed identities, re-sealed packages, and tampered files. Hosted
  testing must also cover registration, qualification intake and activation, a compatible
  release upgrade, withheld advice for retired or inactive verifiers, and unchanged
  ordinary verification requirements.
- **Public-repository hygiene:** inspect the entire allowlisted inventory for identity or
  material from any real repository, private service identifiers or source, credentials,
  environment files, deployment history, local paths, unexpected network clients, and
  unreviewed binaries.
- **Compatibility boundary:** exercise GitHub.com with the documented caller permissions.
  GitHub Enterprise Server remains unsupported while it lacks the required
  `job.workflow_*` properties; do not add an identity fallback.

## Release checklist

A commit is not a release until each item holds for its exact SHA:

- `pnpm run typecheck`, `pnpm run build:release`, and `pnpm run check-release` pass from a
  frozen install.
- The generated runner diff has been compared with its TypeScript source, and the
  complete public inventory has been reviewed.
- A security re-review has closed every applicable category above.
- Repository rules protect `main`, require the `verify-release` check and pull requests,
  and prevent force pushes and deletion.
- Independent approval is claimed only when a reviewer other than the author has reviewed
  the exact candidate.
- A separate-owner, synthetic GitHub repository calls the candidate by its full SHA and
  proves the good, substantial-refactor, intentional-change, and verifier-tamper paths
  without exposing any real repository's material.
- Adversarial canaries reject copied or local workflow identity, mutable references, a
  wrong audience, replay, a wrong target SHA, incomplete results, and altered verifier
  material.
- After merge, the immutable `main` SHA receives the same deterministic checks and a final
  synthetic cross-repository canary before it is marked supported in Balladeer's release
  registry or pinned in any calling repository's workflow.

A pre-merge canary may use only synthetic material and an isolated test workspace. It is
evidence about the candidate, not authority to mark the release supported. Tags are
optional discovery metadata and never authorization.

## Relationship to Balladeer's service

The workflow and runner here pair with Balladeer's service, whose source is not public.
Before an end-to-end canary, compare the exact commits on both sides for protocol fields,
the fixed origin and audience, GitHub OIDC claims, release standing, challenge replay
rules, manifest and result schemas, and revocation behavior. The service's implementation
and identifiers stay out of this repository, and nothing from it is trusted as executable
input here. The public runner and workflow remain independently reviewable and are
selected only by GitHub-owned workflow identity.

Passing this checklist does not by itself make a release supported. Balladeer's service
has its own deployment gates, and the two are independent.
