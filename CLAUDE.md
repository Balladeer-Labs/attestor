# Claude Code instructions

Read this file, [SECURITY-REVIEW.md](SECURITY-REVIEW.md),
[TRUST-BOUNDARY.md](TRUST-BOUNDARY.md), and
[RELEASE-POLICY.md](RELEASE-POLICY.md) before changing anything.

## What this repository is

This public repository is Balladeer's deliberately small GitHub Actions trust anchor. It
contains only the reusable workflow, the auditable continuity-runner source, the
source-reproducible prebuilt runner, and the checks and public policies required to
review an immutable release. It is not the Balladeer application or control plane.

Keep this repository public-safe. Never add customer identity or material, private
control-plane source, private service or provider identifiers, repository credentials,
secrets, environment files, deployment state, or local filesystem paths. Never fetch or
copy those things here to make a test pass.

## Non-negotiable trust properties

- GitHub's `job.workflow_repository`, `job.workflow_ref`, `job.workflow_sha`, and
  `job.workflow_file_path` identify the reusable workflow and executable. The workflow
  must require the permanent repository and workflow path, require an immutable SHA,
  check out that SHA, verify checkout `HEAD`, and execute only its prebuilt runner.
- A control-plane response, caller input, caller variable, branch, or tag must never
  select the attestor repository, revision, executable, endpoint, or OIDC audience.
- The control-plane origin and OIDC audience stay fixed at
  `https://attest.balladeer.ai`. They are not inputs, variables, or secrets.
- There is no caller-supplied setup hook. Preparation that determines how a promise is
  asserted belongs in the promise-owned, digest-locked material tree.
- Source-reading jobs cannot mint OIDC. Token-bearing jobs cannot check out customer
  source and receive only closed result JSON. Do not collapse these jobs.
- All third-party actions use full 40-character commit SHAs. GitHub runner images,
  Node, network calls, jobs, and verifier processes remain explicitly bounded.
- Controls and promises run serially unless a future security review proves that
  concurrency preserves isolation and deterministic custody.
- `release/continuity-runner` must reproduce byte-for-byte from the reviewed TypeScript.
  Never hand-edit generated JavaScript or build/install the attestor in customer CI.
- The exact public-file allowlist and the absence of customer/private/secret material
  are release properties, not housekeeping.

If a requested change conflicts with one of these properties, stop and explain the
conflict. Do not weaken an assertion, broaden the public inventory, or invent a fallback
merely to obtain a green check.

## Required workflow for every change

1. State which custody or trust claim the change affects.
2. Update source and regenerate the prebuilt runner when runner behavior changes.
3. Update the public policies and the threat/re-test ledger in
   [SECURITY-REVIEW.md](SECURITY-REVIEW.md) when the boundary changes.
4. Run:

   ```sh
   pnpm install --frozen-lockfile --ignore-scripts
   pnpm run typecheck
   pnpm run build:release
   pnpm run check-release
   ```

5. Review the source and generated diff, then run the applicable adversarial and
   cross-repository canaries listed in `SECURITY-REVIEW.md`.

Do not merge, tag, register a production-supported release, generate a customer pin, or
use a release with customer material until every applicable gate in
`SECURITY-REVIEW.md` is satisfied. A green deterministic check is necessary but is not
cross-repository or customer-value proof.

