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
  duplicate envelope material. Confirm verifier entrypoints stay inside the declared
  envelope tree, all regular files in that tree are declared and digest-locked, and
  assertion-defining helpers cannot hide outside it. Product code used as the system
  under test may remain outside the custody claim.
- **Setup-hook poisoning:** confirm no free-form setup command or equivalent pre-verifier
  execution surface exists. Preparation that determines the assertion must be declared
  package material.
- **Bounded execution:** confirm controls and envelopes run serially, verifier processes
  are time-bounded, every job has a wall-clock timeout, and every authored HTTP request
  has connection and total timeouts.
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
#1, at handoff commit `8add088`, implements the application-side lifecycle and release
authority it expects to pair with this workflow. That private commit is coordination
context, not trusted executable input and not proof that either side is ready.

Before an end-to-end canary, compare the two exact heads for protocol fields, fixed origin
and audience, GitHub OIDC claims, release/enrollment standing, challenge replay rules,
manifest/result schemas, and revocation behavior. Keep implementation details and all
private identifiers in the private repository. If the private head changes, record its
new coordination commit in that repository's handoff; do not copy its source or secrets
here. The public runner and workflow remain independently reviewable and are selected
only by GitHub-owned workflow identity.

Neither draft is merged, tagged, production-registered, or approved for customer use
merely because this checklist exists. The release gates above and the private
control-plane's own deployment gates remain independent.

