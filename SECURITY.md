# Security policy and boundary

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue. Use GitHub's private
security-advisory reporting for `Balladeer-Labs/attestor`. Include the affected commit
SHA, the custody claim at risk, and a minimal reproduction. Do not include customer
source, fixtures, logs, or credentials.

## What this repository protects

This repository is intentionally public and never holds secrets. Security comes from an
auditable implementation plus GitHub-signed identity, not source-code secrecy. The
Balladeer control plane validates the customer repository identity, caller workflow,
called workflow, and exact called-workflow SHA against the active enrollment.

The workflow has three deliberate boundaries:

1. `register` and the publisher jobs can request OIDC but never check out customer source.
2. `verify` and `qualify-controls` can read customer source but have no OIDC permission.
3. The runner gives token-bearing jobs only normalized outcomes and SHA-256 digests. It
   does not send paths, prompts, logs, raw stdout/stderr, fixtures, or source to Balladeer.

The runner invokes customer-authored verifier processes with a minimal environment. It is
not a sandbox against a deliberately malicious process on the same GitHub runner. The
custody guarantee is designed to catch accidental changes and ordinary agent tampering;
customers remain responsible for their verifier code and GitHub runner policy.

There is no caller-supplied setup command. Verifier preparation must live in the
envelope-owned `.continuity/envelopes/<envelope-id>/` tree. The package must enumerate
every regular file in that tree, symbolic links and special files are rejected, and every
declared byte is digest-checked before sealing, qualification, and execution. The declared
verifier command must point to a verifier inside the same tree.

A verifier can import or invoke application code outside its envelope tree because that
code is the system under test. Those external dependencies are not verifier custody. If a
helper determines how the promise is asserted rather than implementing the product being
tested, move it into the envelope tree and declare it as support material.

The attestor executable is selected solely from GitHub's identity for the running reusable
workflow: `job.workflow_repository`, `job.workflow_ref`, `job.workflow_sha`, and
`job.workflow_file_path`. The workflow refuses a mutable ref, checks out its own repository
at its own workflow SHA into a run-derived staging path, verifies `HEAD`, and moves the
checkout into `RUNNER_TEMP` before customer code executes. A control-plane response cannot
choose the repository, revision, or executable.

These workflow-identity properties are unavailable on GitHub Enterprise Server, which is
therefore outside the v0 support boundary.

## Fixed destinations

Balladeer-authored HTTP requests go only to `https://attest.balladeer.ai`. OIDC tokens
request the fixed audience `https://attest.balladeer.ai`. Neither value may become a
workflow input, caller variable, or secret: doing so would let a caller redirect an
attestor-bound token or evidence.

The workflow also uses GitHub's checkout, OIDC, and artifact services. Customer verifier
processes may use other network destinations permitted by the customer and GitHub; that
activity is outside Balladeer's authored egress and is not represented as Balladeer data
transfer.

## Release discipline

Every dependency action is pinned to a full commit SHA. The prebuilt runner must reproduce
byte-for-byte from the checked-in TypeScript. Every public file is allowlisted by the
release check. Never add customer artifacts, private registry URLs, local filesystem
paths, credentials, control-plane source, or private deployment metadata.

An endpoint, audience, workflow, runner, or release-policy change is security-sensitive.
It requires CODEOWNERS review, a new immutable commit SHA, and an explicit control-plane
release-registry update. See [RELEASE-POLICY.md](RELEASE-POLICY.md).
