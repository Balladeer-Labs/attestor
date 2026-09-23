# Instructions for contributors and coding agents

Read this file, [SECURITY-REVIEW.md](SECURITY-REVIEW.md),
[TRUST-BOUNDARY.md](TRUST-BOUNDARY.md), and
[RELEASE-POLICY.md](RELEASE-POLICY.md) before changing anything.

## What this repository is

This public repository holds the GitHub Actions workflow that Balladeer's CI integration
runs in a calling repository, the auditable source of the continuity runner, the prebuilt
runner that rebuilds byte for byte from that source, and the checks and public policies
needed to review an immutable release. It does not contain the Balladeer application or
Balladeer's service. [README.md](README.md) explains what the workflow does.

Keep this repository safe to publish. Never add identity or material from any real
repository that uses Balladeer, source from Balladeer's service, private service or
provider identifiers, repository credentials, secrets, environment files, deployment
state, or local filesystem paths. Never fetch or copy those things here to make a test
pass.

## Properties that must not change

- GitHub's `job.workflow_repository`, `job.workflow_ref`, `job.workflow_sha`, and
  `job.workflow_file_path` identify the reusable workflow and the executable. The
  workflow must require the permanent repository and workflow path, require an immutable
  SHA, check out that SHA, verify the checkout's `HEAD`, and execute only its prebuilt
  runner.
- A response from Balladeer's service, a caller input, a repository variable, a branch, or
  a tag must never select the attestor repository, revision, executable, endpoint, or
  OIDC audience.
- The service origin and OIDC audience stay fixed at `https://attest.balladeer.ai`. They
  are not inputs, variables, or secrets.
- There is no caller-supplied setup hook. Preparation that determines how a promise is
  checked belongs in the promise's own digest-locked folder.
- Jobs that read the calling repository's source cannot mint OIDC tokens. Jobs that hold
  a token cannot check out that source and receive only closed result JSON. Do not merge
  these jobs together.
- Every third-party action uses a full 40-character commit SHA. GitHub runner images,
  Node, network calls, jobs, and verifier processes stay explicitly bounded.
- Controls and promises run serially unless a future security review proves that
  concurrency preserves isolation and deterministic custody.
- `release/continuity-runner` must reproduce byte for byte from the reviewed TypeScript.
  Never hand-edit the generated JavaScript, and never build or install the attestor in
  the calling repository's CI.
- The exact public-file allowlist, and the absence of private material, secrets, and
  material from real repositories, are release properties, not housekeeping.

If a requested change conflicts with one of these properties, stop and explain the
conflict. Do not weaken an assertion, broaden the public inventory, or invent a fallback
merely to get a green check.

## Required steps for every change

1. State which custody or trust claim the change affects.
2. Update the source, and regenerate the prebuilt runner when runner behavior changes.
3. Update the public policies and the threat model and re-test categories in
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

Do not merge, tag, register a production-supported release, pin a release in any calling
repository's workflow, or use a release with material from a real repository until every
applicable gate in `SECURITY-REVIEW.md` is satisfied. A green deterministic check is
necessary, but it is not cross-repository proof or proof of value to anyone using
Balladeer.
