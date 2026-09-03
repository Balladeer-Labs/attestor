# Customer–Balladeer trust boundary

The attestor runs in GitHub Actions on a customer-controlled runner. Balladeer does not
clone the customer's repository and does not receive source, acceptance packages,
fixtures, verifier programs, prompts, or raw verifier output.

## Information exchanged

| Moment | Customer/GitHub sends to Balladeer | Balladeer sends back | Remains in the customer's GitHub run |
| --- | --- | --- | --- |
| Enrollment run | A GitHub-signed OIDC token; workspace locator; repository name, numeric repository ID, numeric owner ID; caller ref, workflow name, workflow ref and workflow SHA; event name; run ID and attempt; base, head, and target commit SHAs | A target UUID, one-run challenge, and frozen active manifest containing only target ID, generation time, promise IDs, package digests, and manifest digest | Repository contents and credentials |
| Verification | Nothing while verifiers execute | Nothing | Source, packages, fixtures, commands, stdout, and stderr, including the verifier output echoed into the customer's own job log |
| Result publication | A fresh GitHub-signed OIDC token; protocol version and target mode; workspace locator, target UUID, manifest digest, run ID, one-run challenge; per-promise runner version, promise ID, package digest, source SHA, control, normalized outcome, exit code, duration, start/completion times, custody state, stdout/stderr/result digests; and a map of promise IDs to null shadow-applicability observations | HTTP acceptance or a closed validation error | Raw output and files used to reach the outcome |
| Qualification on the default branch | A fresh GitHub-signed OIDC token and closed receipt: protocol version; receipt/workspace/revision/binding IDs; repository name and numeric ID; ref, workflow name/ref/SHA; run ID/attempt, event, target/source SHA; semantic, package, verifier, fixture, and workflow digests; recorded time; and good/bad/refactor/tamper outcomes plus result digests | HTTP acceptance or a closed validation error | Files, commands, and raw outputs behind the digests |

The non-secret workspace locator routes a run to the correct Balladeer workspace; it
does not authorize anything. Authorization comes from GitHub's signed OIDC token and
the server's match against the enrolled repository, caller workflow, and immutable
`Balladeer-Labs/attestor` workflow SHA.

## What the customer sees, and Balladeer does not

The runner writes each verifier's own stdout and stderr to its standard error, which is
the customer's own GitHub job log. Alongside it, it writes one sentence per promise
naming the promise, the control, the outcome and the approved observable outcome, the
matching GitHub annotation, and a job-summary table. A failing check is therefore readable
by the person who caused it.

All of that stays inside the customer's GitHub run. Verifier output goes to the customer's
own job log only: it is never part of a result, a digest, or a request to Balladeer, and it
is not among the fields listed in the table above. The runner's standard output remains the
single machine channel, carrying only the closed result JSON. Echoed text is bounded at
1 MiB per stream, stripped of control characters, and always printed behind a fixed
`[balladeer]` prefix so that customer bytes can never begin a line and forge a GitHub
workflow command. Nothing a control-plane response returned is printed beyond bounded
promise ids.

A promise whose sealed package is missing, re-sealed, or ambiguous is reported as one
custody-invalid result for that promise, so the other promises in the same run still
execute and publish. The result carries the package digest the frozen manifest expected;
no verifier runs for it.

## Job isolation

- `register` can mint an OIDC token but never checks out the customer repository.
- `verify` and `qualify-controls` can check out customer source but cannot mint OIDC.
- `publish` and `qualify-publish` can mint OIDC but receive only closed JSON artifacts;
  they never check out customer source.

The reusable workflow identifies its executable with GitHub's own `job.workflow_*`
properties, not a server response. Each source-reading job checks out that repository at
that workflow SHA into a run-derived path, verifies its `HEAD`, and moves it to
`RUNNER_TEMP` before execution. Both jobs use Node 22.18.0 through a full-SHA-pinned setup
action. All jobs use Ubuntu 24.04 and explicit wall-clock limits.

Verifier preparation is part of a digest-locked promise tree rather than an unbound setup
hook. Every regular, non-symlink file under `.continuity/promises/<promise-id>/` must be
declared in that promise's package. Application files imported from outside that tree are
the system under test and are not verifier custody.

This separation limits accidental source transfer and ordinary agent tampering. It is
not a sandbox against a deliberately malicious customer verifier: such a verifier runs
inside the customer's own GitHub job and may use whatever network access GitHub and the
customer permit. Balladeer's authored workflow sends data only to
`https://attest.balladeer.ai` and GitHub's OIDC and artifact services.
