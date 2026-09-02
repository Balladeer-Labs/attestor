# Release and support policy

`Balladeer-Labs/attestor` is a long-lived trust anchor, not a rolling installer.
Every customer enrollment names the full 40-character Git commit SHA of a reviewed
release. Branches and tags are navigation aids only; they never authorize evidence.

## Repository protection

Protect `main` with a repository ruleset that requires pull requests, CODEOWNERS review,
dismisses stale approvals, requires the `verify-release` job, and blocks force pushes and
branch deletion. Enable private vulnerability reporting and secret scanning. Releases
must be created by a Balladeer maintainer; GitHub write access is not delegated to a
customer repository or its Actions token.

## Publishing a release

1. Change the source, regenerate `release/continuity-runner`, and run the complete
   release-integrity workflow.
2. Review the complete public inventory and require CODEOWNERS approval.
3. Merge without rewriting history. Record the resulting commit SHA in the
   control-plane release registry before offering it to any customer.
4. Optionally create a signed, annotated human-readable version tag pointing to the
   release commit. The tag is discoverability metadata, never execution authority.
5. Generate customer caller workflows that pin that exact SHA. Do not generate a
   branch or tag reference.

Released commits are permanent. Do not force-push, delete, or repurpose them. A new
release always receives a new SHA, even for a rollback.

The reusable workflow must continue selecting its runner from GitHub's immutable
`job.workflow_repository` and `job.workflow_sha` identity, then verifying checkout `HEAD`.
Never replace this with repository/ref values returned by the control plane or supplied by
the caller.

## Supported, deprecated, and revoked releases

The private control-plane registry is authoritative for release standing:

- **Supported:** new enrollments and evidence publication are accepted.
- **Deprecated:** existing enrollments continue temporarily; the UI asks owners to
  approve an upgrade. New enrollments must use a supported release.
- **Revoked:** new runs are rejected because the attestor is unsafe or its custody
  claim is invalid. Existing evidence remains historical and is marked with the
  release that produced it.

Upgrades are explicit enrollment revisions. Balladeer never silently changes the SHA
executed by a customer repository. Keep at least one previous safe release supported
until active customers have upgraded, unless a security issue requires revocation.

## Rollback

To roll back behavior, publish a new reviewed commit whose source and prebuilt runner
restore the safe implementation, then enroll that new SHA. Do not move a tag backward
or tell customers to pin an unreviewed historical commit. This preserves an ordered,
inspectable release ledger even when implementation behavior is reverted.
