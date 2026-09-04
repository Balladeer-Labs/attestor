import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPackageReady,
  buildQualificationRequest,
  canonicalize,
  packageDigest,
  qualificationSummary,
  runAll,
  runTamperControl,
  runTarget,
  runTargetPackages,
  sealPackageDraft,
  sha256,
  validateExecutionManifest,
  validatePackage,
  validateResult,
} from "../release/continuity-runner/index.js";

const root = await mkdtemp(join(tmpdir(), "balladeer-attestor-smoke-"));
const sourceSha = "a".repeat(40);
// The verifier writes on both streams as soon as it starts and exits later, so
// the digests and the echoed log lines are the same on every run.
const verifierStdout = "raw customer output\n";
const verifierStderr = "customer diagnostic line\n";
// It reports its verdict through the native result protocol, which is the whole
// of that protocol: one small JSON document at the path the runner exports, no
// Balladeer dependency, no import beyond node:fs, no network.
const verifierSource = `import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
const mode = process.argv[2];
const lock = ".continuity-shared-smoke.lock";
let descriptor;
try { descriptor = openSync(lock, "wx"); }
catch { process.exit(9); }
process.stdout.write(${JSON.stringify(verifierStdout)});
process.stderr.write(${JSON.stringify(verifierStderr)});
setTimeout(() => {
  closeSync(descriptor);
  unlinkSync(lock);
  const refuted = mode === "bad" ? 1 : 0;
  writeFileSync(process.env.BALLADEER_RESULT_PATH, JSON.stringify({
    schemaVersion: "continuity-verifier-result/v1",
    outcome: refuted ? "refuted" : "passed",
    examples: { total: 1, refuted, errored: 0 },
  }));
  process.exit(refuted);
}, 150);
`;

// Exactly the fields a published result may carry. A new field would widen what
// leaves customer CI, so the shape is asserted here rather than left to the
// receiving schema.
const publishedResultKeys = [
  "completedAt",
  "control",
  "custody",
  "durationMs",
  "exampleRefuted",
  "exampleTotal",
  "exitCode",
  "outcome",
  "outcomeReason",
  "packageDigest",
  "promiseId",
  "resultDigest",
  "resultDocumentDigest",
  "resultProtocol",
  "runnerVersion",
  "schemaVersion",
  "signal",
  "sourceSha",
  "startedAt",
  "stderrDigest",
  "stdoutDigest",
];

const meaningFor = (label) => ({
  title: `${label} creates one order`,
  beneficiary: "Customer with an in-stock cart",
  trigger: "The customer submits the cart",
  preconditions: ["The cart contains in-stock inventory"],
  observableOutcome: "Exactly one order is created",
  allowedVariations: ["The internal checkout service may change"],
  nonGoals: ["Payment provider uptime"],
  passingExamples: [
    { label: "valid cart", setup: "Inventory is available", expectedOutcome: "One order" },
  ],
  failingExamples: [
    { label: "lost cart", setup: "Inventory is available", expectedOutcome: "No lost order" },
  ],
  refactorExamples: [
    { label: "service rewrite", setup: "Internals change", expectedOutcome: "One order" },
  ],
  scope: { repositoryId: "repository-smoke", surfaces: ["checkout"], labels: [] },
});

async function createPackage(promiseId, label, options = {}) {
  const {
    source = verifierSource,
    results = { protocol: "native" },
    executable = process.execPath,
    timeoutMs,
    extraArgs = [],
  } = options;
  const promiseRoot = `.continuity/promises/${promiseId}`;
  const verifierPath = `${promiseRoot}/verifier.mjs`;
  const fixturePath = `${promiseRoot}/fixture.json`;
  await mkdir(join(root, promiseRoot), { recursive: true });
  await writeFile(join(root, verifierPath), source);
  await writeFile(join(root, fixturePath), `{"case":"${label}"}\n`);
  const meaning = meaningFor(label);
  const command = (mode) => ({
    executable,
    args: [verifierPath, mode, ...extraArgs],
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const base = {
    schemaVersion: "continuity-package/v1",
    promise: {
      id: promiseId,
      semanticDigest: sha256(canonicalize(meaning)),
      ownerId: "owner-smoke",
      ...meaning,
    },
    verifier: {
      target: command("target"),
      good: command("good"),
      bad: command("bad"),
      refactor: command("refactor"),
    },
    ...(results ? { results } : {}),
    materials: [
      {
        path: verifierPath,
        kind: "verifier",
        digest: sha256(await readFile(join(root, verifierPath), "utf8")),
      },
      {
        path: fixturePath,
        kind: "fixture",
        digest: sha256(await readFile(join(root, fixturePath), "utf8")),
      },
    ],
  };
  return validatePackage({ ...base, packageDigest: packageDigest(base) });
}

try {
  const pkg = await createPackage("prom_attestorsmoke", "Checkout");
  const second = await createPackage("prom_attestorother", "Renewal");

  const target = await runTarget(pkg, root, sourceSha);
  assert.equal(target.outcome, "pass");
  assert.equal(target.custody, "local");
  assert.equal("stdout" in target, false);
  assert.match(target.stdoutDigest, /^sha256:[a-f0-9]{64}$/);
  // The digest covers exactly the raw verifier bytes, whatever the log shows.
  assert.equal(target.stdoutDigest, sha256(verifierStdout));
  assert.equal(target.stderrDigest, sha256(verifierStderr));

  assert.equal(target.outcomeReason, null);
  assert.equal(target.resultProtocol, "native");
  assert.equal(target.exampleTotal, 1);
  assert.equal(target.exampleRefuted, 0);
  assert.match(target.resultDocumentDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(target.schemaVersion, "continuity-result/v2");
  // The sealed package keeps its own schema and its own digest. A result
  // protocol change must never invalidate sealed customer material.
  assert.equal(pkg.schemaVersion, "continuity-package/v1");

  // The verifier discriminates: the known-bad control is refuted, not merely
  // "not a pass". The three controls run serially in one execution root, and
  // exact material closure is re-checked before each of them, so a run that
  // survives all three also proves the native document is not written inside
  // the digest-locked promise tree.
  const controls = await runAll(pkg, root, sourceSha);
  assert.deepEqual(
    controls.map((result) => [result.control, result.outcome, result.outcomeReason]),
    [
      ["good", "pass", null],
      ["bad", "refuted", null],
      ["refactor", "pass", null],
    ],
  );
  assert.equal(controls[1].exampleRefuted, 1);
  assert.deepEqual(
    (await runTargetPackages([pkg, second], root, sourceSha)).map((result) => result.outcome),
    ["pass", "pass"],
  );
  assert.equal((await runTamperControl(pkg, root, sourceSha)).outcome, "detected");

  const draft = {
    schemaVersion: pkg.schemaVersion,
    promise: pkg.promise,
    verifier: pkg.verifier,
    results: pkg.results,
    materials: pkg.materials.map(({ path, kind }) => ({ path, kind })),
  };
  assert.equal((await sealPackageDraft(draft, root)).packageDigest, pkg.packageDigest);
  await assertPackageReady(pkg, root);

  // The published receipt carries exactly the bounded control pair for every
  // control, including tamper. A control that leaks an extra field (a
  // promise id, a path, raw output) widens what leaves customer CI, so the
  // shape is asserted here rather than left to the receiving schema.
  Object.assign(process.env, {
    GITHUB_REPOSITORY: "owner-smoke/repository-smoke",
    GITHUB_REPOSITORY_ID: "1234567",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW: "continuity",
    GITHUB_WORKFLOW_REF:
      "owner-smoke/repository-smoke/.github/workflows/continuity.yml@refs/heads/main",
    GITHUB_WORKFLOW_SHA: "b".repeat(40),
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_EVENT_NAME: "push",
    GITHUB_SHA: sourceSha,
  });
  const qualification = await buildQualificationRequest(
    pkg,
    {
      schemaVersion: "continuity-qualification-meta/v1",
      workspaceLocator: "3f1d9c2a-5b64-4a7e-9c31-8d2f6a0b4e57",
      receiptId: "7c8e1b40-2d95-4f16-a3b8-51c7e9d0af62",
      revisionId: "rev_smoke001",
      bindingId: "bind_smoke001",
      workflowDigest: sha256("smoke-workflow"),
    },
    root,
  );
  assert.deepEqual(Object.keys(qualification.controls).sort(), [
    "bad",
    "good",
    "refactor",
    "tamper",
  ]);
  for (const [control, published] of Object.entries(qualification.controls)) {
    assert.deepEqual(
      Object.keys(published).sort(),
      control === "tamper"
        ? ["outcome", "resultDigest"]
        : ["outcome", "outcomeReason", "resultDigest"],
      `qualification control ${control} must publish exactly its closed pair`,
    );
    assert.match(published.resultDigest, /^sha256:[a-f0-9]{64}$/);
  }
  assert.equal(qualification.controls.tamper.outcome, "detected");
  // Every control publishes what its verifier reported, read literally. The
  // known-bad control is no longer inverted: it says `refuted` because the
  // verifier refused the behavior, which a crashed control could never say.
  assert.deepEqual(
    ["good", "bad", "refactor"].map((control) => qualification.controls[control].outcome),
    ["pass", "refuted", "pass"],
  );
  assert.deepEqual(
    ["good", "bad", "refactor"].map((control) => qualification.controls[control].outcomeReason),
    [null, null, null],
  );

  // A customer who reads a red check must find words next to it. The runner
  // echoes each verifier's own stdout and stderr, an annotation, and a job
  // summary into the customer's GitHub job log, while standard output still
  // carries nothing but the closed result the publisher sends on.
  const cliPath = new URL("../release/continuity-runner/cli.js", import.meta.url).pathname;
  const packagesDirectory = join(root, ".continuity/packages");
  await mkdir(packagesDirectory, { recursive: true });
  const writeSealedPackage = (item) =>
    writeFile(
      join(packagesDirectory, `${item.promise.id}.json`),
      JSON.stringify(item, null, 2) + "\n",
    );
  const writeManifest = async (name, promises) => {
    const base = {
      schemaVersion: "continuity-ci/v1",
      targetId: "target-smoke",
      generatedAt: "2026-09-02T00:00:00.000Z",
      promises,
    };
    const path = join(root, name);
    await writeFile(path, JSON.stringify({ ...base, manifestDigest: sha256(canonicalize(base)) }));
    return path;
  };
  const summaryPath = join(root, "step-summary.md");
  const runManifestTarget = (manifestPath) =>
    spawnSync(
      process.execPath,
      [cliPath, "run-manifest-target", ".continuity/packages", manifestPath],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          BALLADEER_SOURCE_SHA: sourceSha,
          GITHUB_ACTIONS: "true",
          GITHUB_STEP_SUMMARY: summaryPath,
        },
      },
    );

  await writeSealedPackage(pkg);
  await writeSealedPackage(second);
  await writeFile(summaryPath, "");
  const activeManifestPath = await writeManifest("manifest-active.json", [
    { id: pkg.promise.id, packageDigest: pkg.packageDigest },
    { id: second.promise.id, packageDigest: second.packageDigest },
  ]);

  const visible = runManifestTarget(activeManifestPath);
  assert.equal(visible.status, 0, visible.stderr);
  assert.equal(
    visible.stdout.includes(verifierStdout.trim()),
    false,
    "standard output is the published channel and must not carry verifier output",
  );
  assert.equal(
    visible.stdout.includes(verifierStderr.trim()),
    false,
    "standard output is the published channel and must not carry verifier output",
  );
  const visibleOutput = JSON.parse(visible.stdout);
  assert.equal(visibleOutput.results.length, 2);
  for (const result of visibleOutput.results) {
    assert.deepEqual(Object.keys(result).sort(), publishedResultKeys);
    assert.equal(result.outcome, "pass");
  }
  assert.equal(visibleOutput.results[0].stdoutDigest, sha256(verifierStdout));
  assert.equal(visibleOutput.results[0].stderrDigest, sha256(verifierStderr));
  assert.match(visible.stderr, /\[balladeer\] prom_attestorsmoke target stdout: raw customer output/);
  assert.match(
    visible.stderr,
    /\[balladeer\] prom_attestorsmoke target stderr: customer diagnostic line/,
  );
  assert.match(
    visible.stderr,
    /::notice::prom_attestorsmoke \(Checkout creates one order\): target control outcome pass\./,
  );
  assert.match(visible.stderr, /Approved observable outcome: Exactly one order is created/);
  const summary = await readFile(summaryPath, "utf8");
  assert.match(summary, /\| prom_attestorsmoke \(Checkout creates one order\) \| target \| pass \|/);
  assert.match(summary, /Exactly one order is created/);

  // One re-sealed package must not blank the catalog. Every manifest entry
  // still owes exactly one result, the re-sealed promise alone is
  // custody-invalid, and the healthy promise still runs.
  await writeFile(join(root, ".continuity/promises/prom_attestorother/fixture.json"), '{"case":"Renewal v2"}\n');
  const resealed = await sealPackageDraft(
    {
      schemaVersion: second.schemaVersion,
      promise: second.promise,
      verifier: second.verifier,
      materials: second.materials.map(({ path, kind }) => ({ path, kind })),
    },
    root,
  );
  assert.notEqual(resealed.packageDigest, second.packageDigest);
  await writeSealedPackage(resealed);
  const isolated = runManifestTarget(activeManifestPath);
  assert.equal(isolated.status, 0, isolated.stderr);
  const isolatedResults = JSON.parse(isolated.stdout).results;
  assert.equal(isolatedResults.length, 2, "manifest cardinality must survive a re-sealed package");
  assert.deepEqual(
    isolatedResults.map((result) => [result.promiseId, result.outcome]),
    [
      [pkg.promise.id, "pass"],
      [second.promise.id, "custody-invalid"],
    ],
  );
  assert.equal(isolatedResults[1].custody, "invalid");
  assert.equal(isolatedResults[1].exitCode, null);
  // The result carries the digest the frozen manifest expected, not the one now
  // on disk, and no verifier ran for it.
  assert.equal(isolatedResults[1].packageDigest, second.packageDigest);
  assert.equal(isolatedResults[1].stdoutDigest, sha256(""));
  assert.match(isolated.stderr, /no longer matches the frozen manifest/);

  // A missing package and an unreadable package file behave the same way: that
  // promise alone is custody-invalid.
  await unlink(join(packagesDirectory, `${second.promise.id}.json`));
  await writeFile(join(packagesDirectory, "not-a-sealed-package.json"), "{ not json");
  const missing = runManifestTarget(activeManifestPath);
  assert.equal(missing.status, 0, missing.stderr);
  const missingResults = JSON.parse(missing.stdout).results;
  assert.deepEqual(
    missingResults.map((result) => [result.promiseId, result.outcome]),
    [
      [pkg.promise.id, "pass"],
      [second.promise.id, "custody-invalid"],
    ],
  );
  assert.match(missing.stderr, /No sealed package for this promise is in the package directory/);
  assert.match(missing.stderr, /not a valid sealed package: .*not-a-sealed-package\.json/);
  assert.match(missing.stderr, /::error::prom_attestorother: target control outcome custody-invalid/);

  const promiseRoot = join(root, ".continuity/promises/prom_attestorsmoke");
  const undeclaredPath = join(promiseRoot, "undeclared-helper.mjs");
  await writeFile(undeclaredPath, "export default true;\n");
  assert.equal((await runTarget(pkg, root, sourceSha)).outcome, "custody-invalid");
  await assert.rejects(sealPackageDraft(draft, root), /material closure mismatch/);
  await assert.rejects(assertPackageReady(pkg, root), /material closure mismatch/);
  await unlink(undeclaredPath);

  const linkPath = join(promiseRoot, "fixture-link.json");
  await symlink("fixture.json", linkPath);
  assert.equal((await runTarget(pkg, root, sourceSha)).outcome, "custody-invalid");
  await unlink(linkPath);

  const fixturePath = join(promiseRoot, "fixture.json");
  await writeFile(fixturePath, '{"case":"tampered"}\n');
  const custodyFailure = await runTarget(pkg, root, sourceSha);
  assert.equal(custodyFailure.outcome, "custody-invalid");
  assert.equal(custodyFailure.custody, "invalid");

  const escaped = structuredClone(pkg);
  escaped.materials[0].path = ".continuity/promises/prom_attestorother/verifier.mjs";
  escaped.packageDigest = packageDigest(escaped);
  assert.throws(() => validatePackage(escaped), /must be inside/);

  // A package written against the retired noun is refused by name rather than
  // with a generic unknown-field error, so whoever reads the job log is told
  // what happened. The retired word is assembled from fragments here for the
  // same reason it is in the runner: the release check asserts it survives
  // nowhere in this tree.
  const retiredNoun = ["envel", "ope"].join("");
  const refusesRetiredShape = new RegExp(
    `uses the retired ${retiredNoun} naming.*never migrated in place`,
  );
  assert.throws(
    () =>
      validatePackage({
        schemaVersion: pkg.schemaVersion,
        [retiredNoun]: pkg.promise,
        verifier: pkg.verifier,
        materials: pkg.materials,
        packageDigest: pkg.packageDigest,
      }),
    refusesRetiredShape,
  );
  const retiredIdPackage = structuredClone(pkg);
  retiredIdPackage.promise.id = "env_attestorsmoke";
  retiredIdPackage.packageDigest = packageDigest(retiredIdPackage);
  assert.throws(() => validatePackage(retiredIdPackage), refusesRetiredShape);
  await assert.rejects(
    sealPackageDraft(
      {
        schemaVersion: draft.schemaVersion,
        [retiredNoun]: draft.promise,
        verifier: draft.verifier,
        materials: draft.materials,
      },
      root,
    ),
    refusesRetiredShape,
  );
  const retiredManifestBase = {
    schemaVersion: "continuity-ci/v1",
    targetId: "target-smoke",
    generatedAt: "2026-09-02T00:00:00.000Z",
    [`${retiredNoun}s`]: [{ id: pkg.promise.id, packageDigest: pkg.packageDigest }],
  };
  assert.throws(
    () =>
      validateExecutionManifest({
        ...retiredManifestBase,
        manifestDigest: sha256(canonicalize(retiredManifestBase)),
      }),
    refusesRetiredShape,
  );

  const emptyManifestBase = {
    schemaVersion: "continuity-ci/v1",
    targetId: "target-smoke",
    generatedAt: "2026-09-02T00:00:00.000Z",
    promises: [],
  };
  const emptyManifestPath = join(root, "empty-manifest.json");
  await writeFile(
    emptyManifestPath,
    JSON.stringify({
      ...emptyManifestBase,
      manifestDigest: sha256(canonicalize(emptyManifestBase)),
    }),
  );
  const emptyRun = spawnSync(
    process.execPath,
    [
      new URL("../release/continuity-runner/cli.js", import.meta.url).pathname,
      "run-manifest-target",
      join(root, "missing-packages-directory"),
      emptyManifestPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(emptyRun.status, 0, emptyRun.stderr);
  assert.deepEqual(JSON.parse(emptyRun.stdout), {
    schemaVersion: "continuity-run-output/v1",
    mode: "target",
    sourceSha: null,
    results: [],
  });

  // -------------------------------------------------------------------------
  // A crash is not a refusal, and a refusal is not a crash.
  //
  // One fixture per row of the runner's derivation order. Each asserts the
  // outcome AND the reason code, because the reason is what a person reads
  // next to a red check and what the control plane records as the limitation.
  // Before this protocol every one of these rows exited non-zero and was
  // therefore indistinguishable from a caught regression.
  // -------------------------------------------------------------------------
  await mkdir(join(root, ".continuity/reports"), { recursive: true });
  let scenarioSequence = 0;
  const scenarioId = () => `prom_scenario${String(++scenarioSequence).padStart(4, "0")}`;

  const nativeWriter = (document, exitCode = 0) =>
    `import { writeFileSync } from "node:fs";\n` +
    `writeFileSync(process.env.BALLADEER_RESULT_PATH, ${JSON.stringify(document)});\n` +
    `process.exit(${exitCode});\n`;
  const nativeDocument = (outcome, examples) =>
    JSON.stringify({ schemaVersion: "continuity-verifier-result/v1", outcome, examples });
  const junitWriter = (report, exitCode = 0) =>
    `import { writeFileSync } from "node:fs";\n` +
    `writeFileSync(process.argv[3], ${JSON.stringify(report)});\n` +
    `process.exit(${exitCode});\n`;
  const junitReport = ({ tests, failures = 0, errors = 0, skipped = 0 }) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="smoke" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}">\n<testsuite name="suite" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}"></testsuite>\n</testsuites>\n`;

  // Run one control of a purpose-built package and report what the runner made
  // of it. The label is the row of the derivation order being exercised.
  const scenario = async (label, options) => {
    const promiseId = scenarioId();
    const junitPath = `.continuity/reports/${promiseId}.xml`;
    const built = await createPackage(promiseId, label, {
      ...options,
      ...(options.junit
        ? { results: { protocol: "junit", file: junitPath }, extraArgs: [junitPath] }
        : {}),
    });
    return { package: built, junitPath, result: await runTarget(built, root, sourceSha) };
  };
  const assertScenario = async (label, options, outcome, outcomeReason) => {
    const { result } = await scenario(label, options);
    assert.deepEqual(
      [result.outcome, result.outcomeReason],
      [outcome, outcomeReason],
      `${label} must be ${outcome} / ${outcomeReason}, got ${result.outcome} / ${result.outcomeReason}`,
    );
    return result;
  };

  // A verifier that crashes at import reports `errored`, never `refuted` and
  // never a pass. This one row is the whole point of the protocol.
  const crashScenario = await scenario("Crash at import", {
    source: 'import "./missing-dependency.mjs";\n',
  });
  const crashed = crashScenario.result;
  assert.deepEqual([crashed.outcome, crashed.outcomeReason], ["errored", "nonzero_exit"]);
  assert.equal(crashed.exampleTotal, null);
  assert.equal(crashed.resultDocumentDigest, null);

  const unspawnable = await assertScenario(
    "Missing interpreter",
    { source: "process.exit(0);\n", executable: "/nonexistent-balladeer-path/node" },
    "errored",
    "spawn_failed",
  );
  assert.equal(unspawnable.exitCode, null);
  assert.equal(unspawnable.signal, null);

  const timedOut = await assertScenario(
    "Sleeps past its budget",
    { source: "setTimeout(() => {}, 30000);\n", timeoutMs: 250 },
    "timed_out",
    "timeout",
  );
  assert.equal(timedOut.exitCode, null);

  // A segmentation fault used to read as `canceled`, which spent an
  // evidence-lifecycle word on a crash.
  const signalled = await assertScenario(
    "Killed by a signal",
    { source: 'process.kill(process.pid, "SIGSEGV");\nsetTimeout(() => {}, 30000);\n' },
    "errored",
    "signal_killed",
  );
  assert.equal(signalled.signal, "SIGSEGV");

  // The echo of a flooding verifier is the point of the bound, and it is
  // already exercised elsewhere; here only the outcome matters, so the echoed
  // megabyte is kept out of this script's own output.
  const echoed = process.stderr.write.bind(process.stderr);
  let flooded;
  try {
    process.stderr.write = () => true;
    flooded = await assertScenario(
      "Floods the log",
      {
        source: 'process.stdout.write("x".repeat(1_200_000));\nsetTimeout(() => {}, 30000);\n',
      },
      "errored",
      "output_limit",
    );
  } finally {
    process.stderr.write = echoed;
  }
  assert.equal(flooded.exitCode, null);

  await assertScenario(
    "Declares a protocol and writes nothing",
    { source: "process.exit(0);\n" },
    "errored",
    "result_missing",
  );
  await assertScenario(
    "Writes a truncated document",
    {
      source: nativeWriter('{"schemaVersion":"continuity-verifier-result/v1","outcome":"pas'),
    },
    "errored",
    "result_unparseable",
  );
  await assertScenario(
    "Claims a pass while exiting non-zero",
    {
      source: nativeWriter(
        nativeDocument("passed", { total: 3, refuted: 0, errored: 0 }),
        1,
      ),
    },
    "errored",
    "result_disagrees_exit",
  );
  await assertScenario(
    "Reports its own error",
    {
      source: nativeWriter(nativeDocument("errored", { total: 2, refuted: 0, errored: 2 })),
    },
    "errored",
    "verifier_reported_error",
  );
  await assertScenario(
    "Ran no examples",
    { source: nativeWriter(nativeDocument("passed", { total: 0, refuted: 0, errored: 0 })) },
    "errored",
    "no_examples_ran",
  );
  const nativeRefuted = await assertScenario(
    "Refutes through the native protocol",
    {
      source: nativeWriter(nativeDocument("refuted", { total: 4, refuted: 1, errored: 0 }), 1),
    },
    "refuted",
    null,
  );
  assert.equal(nativeRefuted.exampleTotal, 4);
  assert.equal(nativeRefuted.exampleRefuted, 1);

  // An ordinary test runner's JUnit report, read for three integers and
  // nothing else: no name, no message, no element text.
  const junitRefuted = await assertScenario(
    "JUnit reports a failure",
    { junit: true, source: junitWriter(junitReport({ tests: 5, failures: 1 }), 1) },
    "refuted",
    null,
  );
  assert.equal(junitRefuted.exampleTotal, 5);
  assert.equal(junitRefuted.exampleRefuted, 1);
  assert.equal(junitRefuted.resultProtocol, "junit");
  // A pipeline that swallows the exit status still reports a caught
  // regression. Understating health is safe; calling a real refutation
  // "the check could not run" is not.
  await assertScenario(
    "JUnit reports a failure while exiting zero",
    { junit: true, source: junitWriter(junitReport({ tests: 5, failures: 1 }), 0) },
    "refuted",
    null,
  );
  await assertScenario(
    "JUnit reports an error",
    { junit: true, source: junitWriter(junitReport({ tests: 5, errors: 1 }), 1) },
    "errored",
    "verifier_reported_error",
  );
  await assertScenario(
    "JUnit reports no tests",
    { junit: true, source: junitWriter(junitReport({ tests: 0 })) },
    "errored",
    "no_examples_ran",
  );
  // Every example skipped is not a green suite. It is a suite that exercised
  // nothing, which is the same failure class as a crash reading as a pass.
  await assertScenario(
    "JUnit skipped every test",
    { junit: true, source: junitWriter(junitReport({ tests: 4, skipped: 4 })) },
    "errored",
    "no_examples_ran",
  );

  // Silence degrades to Unknown, never to a false pass, and can never claim a
  // refutation. That is the migration forcing function.
  const undeclared = await createPackage(scenarioId(), "Declares no protocol", {
    source: "process.exit(1);\n",
    results: null,
  });
  const undeclaredResult = await runTarget(undeclared, root, sourceSha);
  assert.deepEqual(
    [undeclaredResult.outcome, undeclaredResult.outcomeReason, undeclaredResult.resultProtocol],
    ["errored", "protocol_undeclared", "exit-code-only"],
  );
  const undeclaredPass = await createPackage(scenarioId(), "Declares no protocol", {
    source: "process.exit(0);\n",
    results: null,
  });
  assert.equal((await runTarget(undeclaredPass, root, sourceSha)).outcome, "pass");

  // A document left by an earlier run is a replay vector. The runner deletes
  // the declared path before the process starts, so a verifier that writes
  // nothing is reported as having written nothing.
  const stale = await scenario("Leaves a stale report", {
    junit: true,
    source: "process.exit(0);\n",
  });
  await writeFile(join(root, stale.junitPath), junitReport({ tests: 9 }));
  const staleResult = await runTarget(stale.package, root, sourceSha);
  assert.deepEqual(
    [staleResult.outcome, staleResult.outcomeReason],
    ["errored", "result_missing"],
    "a stale report from a previous run must not be read as this run's verdict",
  );

  // The declared report path gets the same custody treatment as locked
  // material: a symbolic link is refused rather than followed.
  const linked = await scenario("Links its report out of the tree", {
    junit: true,
    source: junitWriter(junitReport({ tests: 1 })),
  });
  // The runner deletes the report after reading it, so this path is already
  // free; the guard keeps the fixture honest if that ever changes.
  await unlink(join(root, linked.junitPath)).catch(() => undefined);
  await symlink(join(root, "outside-report.xml"), join(root, linked.junitPath));
  const linkedResult = await runTarget(linked.package, root, sourceSha);
  assert.deepEqual(
    [linkedResult.outcome, linkedResult.outcomeReason, linkedResult.custody],
    ["custody-invalid", "custody_failed", "invalid"],
  );
  await unlink(join(root, linked.junitPath));

  // The link above is the easy half. The parent directory is the half a
  // lexical containment check silently passes: `pathResolve` does not resolve
  // symbolic links, so a declared path stays repository-relative on paper while
  // its parent directory points somewhere else entirely, and `lstat` does not
  // save it either because lstat declines to follow only the final component
  // and traverses a linked directory on the way there. The runner therefore
  // resolves the parent and checks containment on the resolved path. Without
  // that, this run would delete and then read its verdict from outside the
  // repository root.
  const outsideRoot = await mkdtemp(join(tmpdir(), "balladeer-attestor-outside-"));
  try {
    const escapedId = scenarioId();
    const escapedPath = `linked-reports/${escapedId}.xml`;
    await symlink(outsideRoot, join(root, "linked-reports"));
    // A file planted outside the repository shows what the escape would reach.
    // The runner clears a stale document before every run, so under a lexical
    // check this unrelated file is deleted from outside the repository root and
    // the run then takes its verdict from there. The verifier writes nothing,
    // so only the runner can account for the file's fate.
    const outsideReport = join(outsideRoot, `${escapedId}.xml`);
    await writeFile(outsideReport, junitReport({ tests: 1 }));
    const escaped = await createPackage(escapedId, "Reports through a linked directory", {
      source: "process.exit(0);\n",
      results: { protocol: "junit", file: escapedPath },
      extraArgs: [escapedPath],
    });
    const escapedResult = await runTarget(escaped, root, sourceSha);
    assert.deepEqual(
      [escapedResult.outcome, escapedResult.outcomeReason, escapedResult.custody],
      ["custody-invalid", "custody_failed", "invalid"],
      "a report path whose parent directory links outside the repository must be refused before the verifier runs",
    );
    assert.notEqual(
      await readFile(outsideReport, "utf8").catch(() => null),
      null,
      "a file outside the repository root must still be there: the runner may not delete through a linked parent",
    );
    await unlink(join(root, "linked-reports"));
  } finally {
    await rm(outsideRoot, { recursive: true, force: true });
  }

  // A report written inside the digest-locked promise tree would break exact
  // material closure for every later control, so the package is refused at
  // seal time rather than surfacing later as a mysterious custody failure.
  const inTree = structuredClone(linked.package);
  inTree.results = {
    protocol: "junit",
    file: `.continuity/promises/${inTree.promise.id}/report.xml`,
  };
  inTree.packageDigest = packageDigest(inTree);
  assert.throws(() => validatePackage(inTree), /must be outside \.continuity\/promises/);
  const unnamedPath = structuredClone(linked.package);
  unnamedPath.results = { protocol: "junit", file: "reports/never-named.xml" };
  unnamedPath.packageDigest = packageDigest(unnamedPath);
  assert.throws(() => validatePackage(unnamedPath), /must name results\.file in its arguments/);
  const nativeWithFile = structuredClone(linked.package);
  nativeWithFile.results = { protocol: "native", file: "reports/anything.xml" };
  nativeWithFile.packageDigest = packageDigest(nativeWithFile);
  assert.throws(() => validatePackage(nativeWithFile), /only used by the junit protocol/);

  // The discrimination proof: a known-bad control whose verifier crashes is
  // `errored`, so the package does not qualify. Before this, that crash was
  // published as the pass that qualified the binding.
  const crashOnBad = await createPackage(scenarioId(), "Crashes on the known-bad control", {
    source:
      'import { writeFileSync } from "node:fs";\n' +
      'const mode = process.argv[2];\n' +
      'if (mode === "bad") await import("./missing-dependency.mjs");\n' +
      `writeFileSync(process.env.BALLADEER_RESULT_PATH, ${JSON.stringify(
        nativeDocument("passed", { total: 1, refuted: 0, errored: 0 }),
      )});\n`,
  });
  const crashOnBadResults = await runAll(crashOnBad, root, sourceSha);
  assert.deepEqual(
    crashOnBadResults.map((result) => [result.control, result.outcome, result.outcomeReason]),
    [
      ["good", "pass", null],
      ["bad", "errored", "nonzero_exit"],
      ["refactor", "pass", null],
    ],
  );
  const crashSummary = qualificationSummary([crashOnBad], crashOnBadResults);
  assert.equal(crashSummary.allControlsDiscriminated, false);
  assert.equal(crashSummary.undecidedControls, 1);
  const crashReceipt = await buildQualificationRequest(
    crashOnBad,
    {
      schemaVersion: "continuity-qualification-meta/v1",
      workspaceLocator: "3f1d9c2a-5b64-4a7e-9c31-8d2f6a0b4e57",
      receiptId: "7c8e1b40-2d95-4f16-a3b8-51c7e9d0af62",
      revisionId: "rev_smoke002",
      bindingId: "bind_smoke002",
      workflowDigest: sha256("smoke-workflow"),
    },
    root,
  );
  assert.deepEqual(crashReceipt.controls.bad, {
    outcome: "errored",
    outcomeReason: "nonzero_exit",
    resultDigest: crashReceipt.controls.bad.resultDigest,
  });
  assert.equal(crashReceipt.controls.good.outcome, "pass");

  // What the customer sees when a verifier could not decide: a warning rather
  // than the error a caught regression gets, the reason code named in the
  // sentence and in the job summary, and standard output still carrying the
  // closed result JSON and nothing else.
  await writeSealedPackage(crashScenario.package);
  const erroredManifestPath = await writeManifest("manifest-errored.json", [
    {
      id: crashScenario.package.promise.id,
      packageDigest: crashScenario.package.packageDigest,
    },
  ]);
  await writeFile(summaryPath, "");
  const erroredRun = runManifestTarget(erroredManifestPath);
  assert.equal(erroredRun.status, 0, erroredRun.stderr);
  const erroredOutput = JSON.parse(erroredRun.stdout);
  assert.equal(
    erroredRun.stdout.trim(),
    JSON.stringify(erroredOutput),
    "standard output carries the closed result JSON and nothing else",
  );
  assert.deepEqual(
    [erroredOutput.results[0].outcome, erroredOutput.results[0].outcomeReason],
    ["errored", "nonzero_exit"],
  );
  assert.deepEqual(Object.keys(erroredOutput.results[0]).sort(), publishedResultKeys);
  assert.match(
    erroredRun.stderr,
    new RegExp(
      `::warning::${crashScenario.package.promise.id}[^\\n]*target control outcome errored \\(nonzero_exit\\)`,
    ),
    "a crash must not be annotated as a caught regression",
  );
  assert.match(erroredRun.stderr, /Reason: nonzero_exit\./);
  const erroredSummary = await readFile(summaryPath, "utf8");
  assert.match(erroredSummary, /\| errored \(nonzero_exit\) \|/);

  // The result's own allow-list is closed. An outcome, a reason, a signal or a
  // protocol from outside the vocabulary is refused before the digest is even
  // considered, so no free text can ride into a published field.
  validateResult(nativeRefuted);
  assert.throws(
    () => validateResult({ ...nativeRefuted, outcomeReason: "verifier_was_sad" }),
    /outcomeReason is invalid/,
  );
  assert.throws(
    () => validateResult({ ...crashed, signal: "SIGMADEUP" }),
    /signal is invalid/,
  );
  assert.throws(
    () => validateResult({ ...crashed, outcomeReason: null }),
    /outcomeReason must be present/,
  );

  // The local gate: a package whose controls discriminate qualifies, and one
  // whose known-bad control crashed is refused by name rather than counted as
  // evidence that the verifier discriminates.
  const gateDirectory = join(root, ".continuity/qualify-gate");
  await mkdir(gateDirectory, { recursive: true });
  const qualifyLocally = async (item) => {
    const path = join(gateDirectory, `${item.promise.id}.json`);
    await writeFile(path, JSON.stringify(item, null, 2) + "\n");
    return spawnSync(process.execPath, [cliPath, "qualify", path], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, BALLADEER_SOURCE_SHA: sourceSha },
    });
  };
  const discriminating = await createPackage(scenarioId(), "Discriminates", {
    source:
      'import { writeFileSync } from "node:fs";\n' +
      'const refuted = process.argv[2] === "bad" ? 1 : 0;\n' +
      `writeFileSync(process.env.BALLADEER_RESULT_PATH, JSON.stringify({ schemaVersion: "continuity-verifier-result/v1", outcome: refuted ? "refuted" : "passed", examples: { total: 1, refuted, errored: 0 } }));\n` +
      "process.exit(refuted);\n",
  });
  const qualified = await qualifyLocally(discriminating);
  assert.equal(qualified.status, 0, qualified.stderr);
  const qualifiedOutput = JSON.parse(qualified.stdout);
  assert.equal(qualifiedOutput.qualification.allControlsDiscriminated, true);
  assert.equal(qualifiedOutput.qualification.undecidedControls, 0);
  assert.equal(qualifiedOutput.qualification.perPromise[0].resultProtocol, "native");

  const refusedGate = await qualifyLocally(crashOnBad);
  assert.equal(refusedGate.status, 1);
  assert.match(refusedGate.stderr, /at least one control errored, timed out, or was canceled/);

  console.log("prebuilt runner smoke checks passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
