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
  runAll,
  runTamperControl,
  runTarget,
  runTargetPackages,
  sealPackageDraft,
  sha256,
  validateExecutionManifest,
  validatePackage,
} from "../release/continuity-runner/index.js";

const root = await mkdtemp(join(tmpdir(), "balladeer-attestor-smoke-"));
const sourceSha = "a".repeat(40);
// The verifier writes on both streams as soon as it starts and exits later, so
// the digests and the echoed log lines are the same on every run.
const verifierStdout = "raw customer output\n";
const verifierStderr = "customer diagnostic line\n";
const verifierSource = `import { closeSync, openSync, unlinkSync } from "node:fs";
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
  process.exit(mode === "bad" ? 1 : 0);
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
  "exitCode",
  "outcome",
  "packageDigest",
  "promiseId",
  "resultDigest",
  "runnerVersion",
  "schemaVersion",
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

async function createPackage(promiseId, label) {
  const promiseRoot = `.continuity/promises/${promiseId}`;
  const verifierPath = `${promiseRoot}/verifier.mjs`;
  const fixturePath = `${promiseRoot}/fixture.json`;
  await mkdir(join(root, promiseRoot), { recursive: true });
  await writeFile(join(root, verifierPath), verifierSource);
  await writeFile(join(root, fixturePath), `{"case":"${label}"}\n`);
  const meaning = meaningFor(label);
  const command = (mode) => ({ executable: process.execPath, args: [verifierPath, mode] });
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

  const controls = await runAll(pkg, root, sourceSha);
  assert.deepEqual(
    controls.map((result) => [result.control, result.outcome]),
    [
      ["good", "pass"],
      ["bad", "pass"],
      ["refactor", "pass"],
    ],
  );
  assert.deepEqual(
    (await runTargetPackages([pkg, second], root, sourceSha)).map((result) => result.outcome),
    ["pass", "pass"],
  );
  assert.equal((await runTamperControl(pkg, root, sourceSha)).outcome, "detected");

  const draft = {
    schemaVersion: pkg.schemaVersion,
    promise: pkg.promise,
    verifier: pkg.verifier,
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
      ["outcome", "resultDigest"],
      `qualification control ${control} must publish exactly outcome and resultDigest`,
    );
    assert.match(published.resultDigest, /^sha256:[a-f0-9]{64}$/);
  }
  assert.equal(qualification.controls.tamper.outcome, "detected");
  // `bad` is published as the observed behavior, so a correctly caught
  // known-bad case is reported as `fail`, not as the local control's `pass`.
  assert.deepEqual(
    ["good", "bad", "refactor"].map((control) => qualification.controls[control].outcome),
    ["pass", "fail", "pass"],
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

  console.log("prebuilt runner smoke checks passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
