# Release and support policy

`Balladeer-Labs/attestor` is a long-lived trust anchor, not a rolling installer.
Every customer enrollment names the full 40-character Git commit SHA of a reviewed
release. Branches and tags are navigation aids only; they never authorize evidence.

## Repository protection

`main` is protected by a repository ruleset that requires a pull request, CODEOWNERS
review, dismissal of stale approvals, approval of the last push, resolved review threads,
and a green `verify-release` check on an up-to-date branch. Merge commits are the only
permitted merge method, so a released commit is never rewritten on its way to `main`.
Force pushes and branch deletion are blocked. Private vulnerability reporting, secret
scanning, and push protection are enabled. Releases must be created by a Balladeer
maintainer; GitHub write access is not delegated to a customer repository or its Actions
token.

Read that protection together with the single-maintainer exception below, which states
what it does and does not prove today.

## Bootstrap exception: one maintainer

Balladeer has one maintainer, who is also the sole CODEOWNER in `.github/CODEOWNERS`.
GitHub does not allow an author to approve their own pull request, so the approval rule
above cannot be satisfied honestly at this size. Rather than weaken the rule or add a
second account that is really the same person, the organization owner holds a recorded
bypass on the ruleset and merges through it.

What a reader may and may not conclude from a release commit while this exception stands:

- Every commit on `main` reached it through a pull request whose `verify-release` check was
  green, and is protected against rewriting and deletion. Those claims are true now.
- A release commit has not been reviewed by a second person. A merged pull request in this
  repository is not evidence of independent review.
- Each bypassed merge is recorded by GitHub in this repository's rule insights, so the
  exception is inspectable here rather than merely asserted.

This exception ends when a second maintainer exists. Add them to `.github/CODEOWNERS`,
remove the bypass actor from the ruleset, and delete this section in the same pull request.
Until then this section, not the presence of protection, is the accurate statement of what
review a release has had.

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
