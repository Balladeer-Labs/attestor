import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPackageReady,
  canonicalize,
  packageDigest,
  runAll,
  runTamperControl,
  runTarget,
  runTargetPackages,
  sealPackageDraft,
  sha256,
  validatePackage,
} from "../release/continuity-runner/index.js";

const root = await mkdtemp(join(tmpdir(), "balladeer-attestor-smoke-"));
const sourceSha = "a".repeat(40);
const verifierSource = `import { closeSync, openSync, unlinkSync } from "node:fs";
const mode = process.argv[2];
const lock = ".continuity-shared-smoke.lock";
let descriptor;
try { descriptor = openSync(lock, "wx"); }
catch { process.exit(9); }
setTimeout(() => {
  closeSync(descriptor);
  unlinkSync(lock);
  process.stdout.write("raw customer output");
  process.exit(mode === "bad" ? 1 : 0);
}, 150);
`;

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

async function createPackage(envelopeId, label) {
  const envelopeRoot = `.continuity/envelopes/${envelopeId}`;
  const verifierPath = `${envelopeRoot}/verifier.mjs`;
  const fixturePath = `${envelopeRoot}/fixture.json`;
  await mkdir(join(root, envelopeRoot), { recursive: true });
  await writeFile(join(root, verifierPath), verifierSource);
  await writeFile(join(root, fixturePath), `{"case":"${label}"}\n`);
  const meaning = meaningFor(label);
  const command = (mode) => ({ executable: process.execPath, args: [verifierPath, mode] });
  const base = {
    schemaVersion: "continuity-package/v1",
    envelope: {
      id: envelopeId,
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
  const pkg = await createPackage("env_attestorsmoke", "Checkout");
  const second = await createPackage("env_attestorother", "Renewal");

  const target = await runTarget(pkg, root, sourceSha);
  assert.equal(target.outcome, "pass");
  assert.equal(target.custody, "local");
  assert.equal("stdout" in target, false);
  assert.match(target.stdoutDigest, /^sha256:[a-f0-9]{64}$/);

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
    envelope: pkg.envelope,
    verifier: pkg.verifier,
    materials: pkg.materials.map(({ path, kind }) => ({ path, kind })),
  };
  assert.equal((await sealPackageDraft(draft, root)).packageDigest, pkg.packageDigest);
  await assertPackageReady(pkg, root);

  const envelopeRoot = join(root, ".continuity/envelopes/env_attestorsmoke");
  const undeclaredPath = join(envelopeRoot, "undeclared-helper.mjs");
  await writeFile(undeclaredPath, "export default true;\n");
  assert.equal((await runTarget(pkg, root, sourceSha)).outcome, "custody-invalid");
  await assert.rejects(sealPackageDraft(draft, root), /material closure mismatch/);
  await assert.rejects(assertPackageReady(pkg, root), /material closure mismatch/);
  await unlink(undeclaredPath);

  const linkPath = join(envelopeRoot, "fixture-link.json");
  await symlink("fixture.json", linkPath);
  assert.equal((await runTarget(pkg, root, sourceSha)).outcome, "custody-invalid");
  await unlink(linkPath);

  const fixturePath = join(envelopeRoot, "fixture.json");
  await writeFile(fixturePath, '{"case":"tampered"}\n');
  const custodyFailure = await runTarget(pkg, root, sourceSha);
  assert.equal(custodyFailure.outcome, "custody-invalid");
  assert.equal(custodyFailure.custody, "invalid");

  const escaped = structuredClone(pkg);
  escaped.materials[0].path = ".continuity/envelopes/env_attestorother/verifier.mjs";
  escaped.packageDigest = packageDigest(escaped);
  assert.throws(() => validatePackage(escaped), /must be inside/);

  const emptyManifestBase = {
    schemaVersion: "continuity-ci/v1",
    targetId: "target-smoke",
    generatedAt: "2026-09-02T00:00:00.000Z",
    envelopes: [],
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
