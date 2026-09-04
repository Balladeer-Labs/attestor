# Security review and release-gate ledger

This document preserves why the public attestor has its current shape and the evidence
required before anyone treats a commit as a release. It is both a cold-start handoff and
a review checklist; checking a box requires current evidence for the exact commit under
review.

## Original trust failure

The first implementation pinned the reusable workflow in the customer caller, but the
registration response selected an attestor repository and SHA that a later source-reading
job checked out and executed. The pin protected the workflow YAML, not the executable.
If the server response were wrong or compromised, customer CI could execute different
code beside the checked-out customer source. That defeated the public trust anchor.

The hardened design uses only GitHub-owned `job.workflow_*` context for executable
identity. Each source-reading job requires `Balladeer-Labs/attestor`, the exact reusable
workflow path, an immutable workflow SHA, and a matching checkout `HEAD`. The checkout
is moved to `RUNNER_TEMP` and made read-only before any customer verifier runs. The
registration response cannot select a repository, revision, or executable. There is no
caller-provided setup command.

Do not reintroduce the original shape under another name: a release URL, artifact,
download manifest, server response, caller input, variable, branch, tag, or fallback
path cannot decide what executable runs.

## Exact re-test categories

For the exact candidate SHA, review or exercise every applicable category:

- **Executable selection:** attempt to return a different repository, SHA, executable,
  or download location from registration; confirm none is consumed. Attempt caller
  overrides. Confirm the workflow fails closed for a mutable or mismatched workflow
  ref, unexpected repository/path, missing identity property, or mismatched checkout
  `HEAD`. Copied/local workflow variants must not authenticate as this attestor.
- **Fixed identity and egress:** confirm the control-plane origin and OIDC audience occur
  exactly once as fixed workflow constants and cannot be redirected by inputs, variables,
  or secrets. Exercise a wrong audience and wrong called-workflow identity; both must be
  rejected by the service.
- **Privilege and data isolation:** confirm only registration/publisher jobs can mint
  OIDC, those jobs never check out customer source, and source-reading jobs cannot mint
  OIDC. Inspect uploaded artifacts and HTTP bodies to prove they contain only the closed
  schemas described in `TRUST-BOUNDARY.md`, never raw output or files.
- **Runner provenance:** reproduce `release/continuity-runner` byte-for-byte from source,
  confirm every third-party action is full-SHA pinned, confirm the exact Node and Ubuntu
  versions, and confirm customer CI performs no attestor install or compilation.
- **Verifier custody:** reject missing, extra, changed, symlinked, special, escaping, or
  duplicate promise material. Confirm verifier entrypoints stay inside the declared
  promise tree, all regular files in that tree are declared and digest-locked, and
  assertion-defining helpers cannot hide outside it. Product code used as the system
  under test may remain outside the custody claim.
- **Setup-hook poisoning:** confirm no free-form setup command or equivalent pre-verifier
  execution surface exists. Preparation that determines the assertion must be declared
  package material.
- **Bounded execution:** confirm controls and promises run serially, verifier processes
  are time-bounded, every job has a wall-clock timeout, and every authored HTTP request
  has connection and total timeouts.
- **Customer-log output:** confirm verifier stdout and stderr reach the customer's own job
  log and nothing else. Inspect the published artifact and HTTP bodies for echoed text;
  they must still carry only normalized outcomes and digests. Exercise a verifier that
  emits `::error::`, `::stop-commands::`, ANSI escapes, carriage returns, and more than
  1 MiB on each stream: every line must appear behind the fixed prefix, no line may be
  parsed by GitHub as a workflow command, and the echo must stop at the byte bound while
  the digest still covers every byte. Confirm no control-plane response content is printed
  beyond bounded promise ids.
- **Per-package isolation:** confirm one missing, re-sealed, ambiguous, or unreadable
  package yields exactly one custody-invalid result for that promise while every other
  promise still runs and publishes. Confirm the result count still equals the frozen
  manifest's promise count, that the custody-invalid result carries the digest the
  manifest expected, that no verifier ran for it, and that the advisory check still fails
  when any result is not a pass. Isolation must never let a run execute a package the
  manifest did not name.
- **Crash versus refusal:** confirm a verifier that cannot produce a verdict is never
  reported as a pass and never as a refutation. Exercise, for the target run and for the
  known-bad control, a crash at import, a missing interpreter, a wall-clock timeout, a
  fatal signal, an output flood, a declared protocol that wrote no document, a truncated
  document, a document claiming a pass while the process exited non-zero, a suite that
  reported zero tests, and a suite that skipped every test. Each must be `errored` or
  `timed_out` with the reason code that names it, and the known-bad control's crash must
  leave the package unqualified. Confirm the result document is deleted before the process
  starts, so a report left by a previous run cannot be replayed as this run's verdict, and
  that a document path escaping the checkout or reached through a symbolic link is
  `custody-invalid`. Confirm the document's text never reaches a published field, an
  annotation, or standard output, and that no XML or parsing library was added to read it.
  Confirm an exit-code-only package can still pass but can never claim a refutation.
- **Protocol binding and replay:** exercise a good run plus wrong repository/owner IDs,
  wrong caller ref or workflow, wrong target/source SHA, stale or reused challenge,
  mismatched manifest/package digests, incomplete results, and a revoked attestor release.
  All negative cases must fail closed or record the deliberately documented Unknown state.
- **Public-repository hygiene:** inspect the entire allowlisted inventory for customer
  identity/material, private service identifiers or source, credentials, environment
  files, deployment history, local paths, unexpected network clients, and unreviewed
  binaries.
- **Compatibility boundary:** exercise GitHub.com with the documented caller permissions.
  GitHub Enterprise Server remains unsupported while it lacks the required
  `job.workflow_*` properties; do not add an identity fallback.

## Gates for the initial release

No unchecked item may be described as complete:

- [ ] `pnpm run typecheck`, `pnpm run build:release`, and `pnpm run check-release` pass
      from a frozen install for the exact candidate SHA.
- [ ] The generated runner diff has been compared with its TypeScript source, and the
      complete public inventory has been reviewed.
- [ ] An independent security re-review has closed every applicable category above for
      the exact candidate SHA.
- [ ] Repository rules protect `main`, require the `verify-release` check and pull
      requests, and prevent force pushes and deletion.
- [ ] The CODEOWNERS review requirement is actually enforceable. It is not currently
      enforceable with only one maintainer; do not claim independent approval until a
      second authorized reviewer exists and reviews the exact candidate.
- [ ] A separate-owner, synthetic GitHub repository calls the candidate by its full SHA
      and proves the good, substantial-refactor, intentional-change, and verifier-tamper
      paths without exposing customer material.
- [ ] Adversarial canaries reject copied/local workflow identity, mutable references,
      wrong audience, replay, wrong target SHA, incomplete results, and altered verifier
      material.
- [ ] After merge, the immutable `main` SHA receives the same deterministic checks and
      final synthetic cross-repository canary before it is marked supported by the
      production release registry or included in a customer workflow.

A pre-merge canary may use only synthetic material and an isolated, non-customer
enrollment. It is evidence about the candidate, not authority to register the release as
production-supported. Tags are optional discovery metadata and never authorization.

## Relationship to the private control plane

This public draft is one half of a two-repository change. Private control-plane draft PR
#1, at https://github.com/Bobby-tables1/balladeer/pull/1, implements the application-side
lifecycle and release authority it expects to pair with this workflow; the exact private
head that currently carries a finished green verdict is recorded in that repository's
`docs/continuation-handoff.md`, not here, so this document never pins a commit it cannot
keep true. That private work is coordination context, not trusted executable input and not
proof that either side is ready.

Before an end-to-end canary, compare the two exact heads for protocol fields, fixed origin
and audience, GitHub OIDC claims, release/enrollment standing, challenge replay rules,
manifest/result schemas, and revocation behavior. Keep implementation details and all
private identifiers in the private repository, including the coordination commit itself;
do not copy its source or secrets here. The public runner and workflow remain
independently reviewable and are selected only by GitHub-owned workflow identity.

Neither draft is merged, tagged, production-registered, or approved for customer use
merely because this checklist exists. The release gates above and the private
control-plane's own deployment gates remain independent.

