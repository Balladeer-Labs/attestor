import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve as pathResolve } from "node:path";

export const RUNNER_SCHEMA = "continuity-package/v1" as const;
export const RUNNER_VERSION = "0.1.0";
export const CONTROLS = ["good", "bad", "refactor"] as const;
export const RUN_MODES = ["target", ...CONTROLS] as const;
export type Control = (typeof CONTROLS)[number];
export type RunMode = (typeof RUN_MODES)[number];
export type ControlExpectation = "pass" | "fail";

export interface BehavioralExample {
  label: string;
  setup: string;
  expectedOutcome: string;
}

export interface EnvelopeScope {
  repositoryId: string;
  surfaces: string[];
  labels: string[];
}

export interface EnvelopeMeaning {
  id: string;
  semanticDigest: string;
  title: string;
  beneficiary: string;
  trigger: string;
  preconditions: string[];
  observableOutcome: string;
  allowedVariations: string[];
  nonGoals: string[];
  passingExamples: BehavioralExample[];
  failingExamples: BehavioralExample[];
  refactorExamples: BehavioralExample[];
  ownerId: string;
  scope: EnvelopeScope;
}

export interface VerifierCommand {
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}
export interface VerifierSpec {
  target: VerifierCommand;
  good: VerifierCommand;
  bad: VerifierCommand;
  refactor: VerifierCommand;
}
export interface LockedMaterial {
  /** Repository-relative path. It is never sent to the hosted control plane. */
  path: string;
  kind: "verifier" | "fixture" | "support";
  digest: string;
}
export interface AcceptancePackage {
  schemaVersion: typeof RUNNER_SCHEMA;
  envelope: EnvelopeMeaning;
  verifier: VerifierSpec;
  materials: LockedMaterial[];
  packageDigest: string;
}
export interface AcceptancePackageDraft {
  schemaVersion: typeof RUNNER_SCHEMA;
  envelope: EnvelopeMeaning;
  verifier: VerifierSpec;
  materials: Array<Omit<LockedMaterial, "digest">>;
}

export interface QualificationMetadata {
  schemaVersion: "continuity-qualification-meta/v1";
  workspaceLocator: string;
  receiptId: string;
  revisionId: string;
  bindingId: string;
  workflowDigest: string;
}

export interface TamperControlResult {
  envelopeId: string;
  outcome: "detected" | "not_detected" | "unknown";
  resultDigest: string;
}

export interface ScaffoldResult {
  root: string;
  draftPath: string;
  verifierPath: string;
  fixturePath: string;
  readmePath: string;
}

export type RunOutcome = "pass" | "fail" | "unknown" | "canceled" | "custody-invalid";
export interface RunResult {
  schemaVersion: typeof RUNNER_SCHEMA;
  runnerVersion: string;
  envelopeId: string;
  packageDigest: string;
  /** The exact commit checked out by the customer runner. */
  sourceSha: string;
  control: RunMode;
  outcome: RunOutcome;
  exitCode: number | null;
  durationMs: number;
  stdoutDigest: string;
  stderrDigest: string;
  startedAt: string;
  completedAt: string;
  custody: "local" | "invalid";
  resultDigest: string;
}

export interface ExecutionManifest {
  schemaVersion: "continuity-ci/v1";
  targetId: string;
  generatedAt: string;
  envelopes: { id: string; packageDigest: string }[];
  manifestDigest: string;
}

const meaningKeys = [
  "id",
  "semanticDigest",
  "title",
  "beneficiary",
  "trigger",
  "preconditions",
  "observableOutcome",
  "allowedVariations",
  "nonGoals",
  "passingExamples",
  "failingExamples",
  "refactorExamples",
  "ownerId",
  "scope",
];
const commandKeys = ["executable", "args", "cwd", "timeoutMs"];
const packageKeys = ["schemaVersion", "envelope", "verifier", "materials", "packageDigest"];
const resultKeys = [
  "schemaVersion",
  "runnerVersion",
  "envelopeId",
  "packageDigest",
  "sourceSha",
  "control",
  "outcome",
  "exitCode",
  "durationMs",
  "stdoutDigest",
  "stderrDigest",
  "startedAt",
  "completedAt",
  "custody",
  "resultDigest",
];
const isGitSha = (value: unknown): value is string =>
  typeof value === "string" && value.length === 40 && /^[0-9a-f]{40}$/.test(value);

// The scaffold's marker is deliberately not the only readiness guard. A
// customer can remove a comment without having authored a verifier. Keep a
// normalized structural fingerprint of the generated control program so that
// whitespace/comments (including the marker itself) cannot launder it.
const scaffoldVerifierStructure =
  'const control = process.argv[2];process.exit(control === "bad" ? 1 : 0);';
const normalizedSource = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\s+/g, "");
const scaffoldVerifierStructureDigest = sha256(normalizedSource(scaffoldVerifierStructure));

function isScaffoldVerifierSource(contents: Buffer): boolean {
  return sha256(normalizedSource(contents.toString("utf8"))) === scaffoldVerifierStructureDigest;
}

function keysAre(
  value: unknown,
  expected: string[],
  label: string,
  optional: string[] = [],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const actual = Object.keys(value as object);
  for (const key of actual)
    if (!expected.includes(key)) throw new Error(`${label} has unknown field: ${key}`);
  for (const key of expected)
    if (!optional.includes(key) && !actual.includes(key))
      throw new Error(`${label} is missing field: ${key}`);
}
function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string`);
  return value;
}
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    throw new Error(`${label} must be an array of strings`);
  return value;
}

/**
 * A command is only executable as part of a package when it names the exact
 * normalized path of at least one locked verifier material.  This is a
 * deliberately small binding: it prevents a package from declaring one
 * verifier while actually running `/bin/true`, `node -e`, or an unrelated
 * locked file.  It does not claim that the named program is semantically
 * correct; the digest and the controls provide the remaining evidence.
 */
function commandReferencesVerifierMaterial(
  command: VerifierCommand,
  verifierPaths: Set<string>,
): boolean {
  const normalized = (token: string) => (token.startsWith("./") ? token.slice(2) : token);
  if (verifierPaths.has(normalized(command.executable))) return true;

  // Interpreter invocation is intentionally narrow: the locked verifier must
  // be the first argument, not a decoy after an inline program or module flag.
  const executableName = command.executable.split("/").at(-1)?.toLowerCase() ?? "";
  const interpreters = /^(node|node\.exe|python(?:3(?:\.\d+)?)?|ruby|perl|bash|sh|dash|zsh|tsx)$/;
  if (!interpreters.test(executableName) || command.args.length === 0) return false;
  return verifierPaths.has(normalized(command.args[0]!));
}

function digestField(value: unknown, label: string): string {
  const digest = stringField(value, label);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} must be a SHA-256 digest`);
  return digest;
}

function validateExamples(value: unknown, label: string): BehavioralExample[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12)
    throw new Error(`${label} must contain between 1 and 12 examples`);
  for (const [index, example] of value.entries()) {
    keysAre(example, ["label", "setup", "expectedOutcome"], `${label}[${index}]`);
    stringField(example.label, `${label}[${index}].label`);
    stringField(example.setup, `${label}[${index}].setup`);
    stringField(example.expectedOutcome, `${label}[${index}].expectedOutcome`);
  }
  return value as BehavioralExample[];
}

function semanticMeaning(envelope: EnvelopeMeaning) {
  const { id: _id, ownerId: _ownerId, semanticDigest: _semanticDigest, ...meaning } = envelope;
  return meaning;
}

export function canonicalize(value: unknown): string {
  if (value === undefined) throw new Error("cannot canonicalize undefined");
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("cannot canonicalize non-finite number");
  if (["bigint", "symbol", "function"].includes(typeof value))
    throw new Error("cannot canonicalize unsupported value");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("can only canonicalize plain objects");
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}
export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function withoutDigest(pkg: AcceptancePackage): Omit<AcceptancePackage, "packageDigest"> {
  const { packageDigest: _ignored, ...rest } = pkg;
  return rest;
}
function resultWithoutDigest(result: RunResult): Omit<RunResult, "resultDigest"> {
  const { resultDigest: _ignored, ...rest } = result;
  return rest;
}

export function packageDigest(
  pkg: Omit<AcceptancePackage, "packageDigest"> | AcceptancePackage,
): string {
  return sha256(canonicalize(withoutDigest(pkg as AcceptancePackage)));
}
export function validatePackage(input: unknown): AcceptancePackage {
  keysAre(input, packageKeys, "package");
  if (input.schemaVersion !== RUNNER_SCHEMA)
    throw new Error(`package.schemaVersion must be ${RUNNER_SCHEMA}`);
  keysAre(input.envelope, meaningKeys, "envelope");
  const envelopeId = stringField(input.envelope.id, "envelope.id");
  for (const key of ["title", "beneficiary", "trigger", "observableOutcome", "ownerId"])
    stringField(input.envelope[key], `envelope.${key}`);
  if (!/^env_[a-z0-9]{8,64}$/.test(envelopeId))
    throw new Error("envelope.id is invalid");
  digestField(input.envelope.semanticDigest, "envelope.semanticDigest");
  for (const key of ["preconditions", "allowedVariations", "nonGoals"])
    stringArray(input.envelope[key], `envelope.${key}`);
  for (const key of ["passingExamples", "failingExamples", "refactorExamples"])
    validateExamples(input.envelope[key], `envelope.${key}`);
  keysAre(input.envelope.scope, ["repositoryId", "surfaces", "labels"], "envelope.scope");
  stringField(input.envelope.scope.repositoryId, "envelope.scope.repositoryId");
  const surfaces = stringArray(input.envelope.scope.surfaces, "envelope.scope.surfaces");
  stringArray(input.envelope.scope.labels, "envelope.scope.labels");
  if (surfaces.length < 1) throw new Error("envelope.scope.surfaces requires at least one marker");
  const typedEnvelope = input.envelope as unknown as EnvelopeMeaning;
  if (typedEnvelope.semanticDigest !== sha256(canonicalize(semanticMeaning(typedEnvelope))))
    throw new Error("envelope.semanticDigest does not match approved meaning");
  keysAre(input.verifier, ["target", "good", "bad", "refactor"], "verifier");
  for (const control of RUN_MODES) {
    const command = input.verifier[control];
    keysAre(command, commandKeys, `verifier.${control}`, ["cwd", "timeoutMs"]);
    stringField(command.executable, `verifier.${control}.executable`);
    stringArray(command.args, `verifier.${control}.args`);
    if (command.cwd !== undefined) stringField(command.cwd, `verifier.${control}.cwd`);
    if (
      command.timeoutMs !== undefined &&
      (typeof command.timeoutMs !== "number" ||
        !Number.isSafeInteger(command.timeoutMs) ||
        command.timeoutMs < 1 ||
        command.timeoutMs > 600_000)
    )
      throw new Error(`verifier.${control}.timeoutMs out of range`);
  }
  if (!Array.isArray(input.materials) || input.materials.length < 2 || input.materials.length > 256)
    throw new Error("materials must contain between 2 and 256 locked files");
  const materialPaths = new Set<string>();
  let verifierCount = 0;
  let fixtureCount = 0;
  for (const [index, material] of input.materials.entries()) {
    keysAre(material, ["path", "kind", "digest"], `materials[${index}]`);
    const path = stringField(material.path, `materials[${index}].path`);
    if (
      isAbsolute(path) ||
      path.includes("\\") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")
    )
      throw new Error(`materials[${index}].path must be a normalized repository-relative path`);
    if (!path.startsWith(`.continuity/envelopes/${envelopeId}/`))
      throw new Error(
        `materials[${index}].path must be inside .continuity/envelopes/${envelopeId}`,
      );
    if (!["verifier", "fixture", "support"].includes(material.kind as string))
      throw new Error(`materials[${index}].kind is invalid`);
    digestField(material.digest, `materials[${index}].digest`);
    if (materialPaths.has(path)) throw new Error(`materials contains duplicate path: ${path}`);
    materialPaths.add(path);
    if (material.kind === "verifier") verifierCount += 1;
    if (material.kind === "fixture") fixtureCount += 1;
  }
  if (verifierCount < 1 || fixtureCount < 1)
    throw new Error("materials requires at least one verifier file and one fixture file");
  const verifierPaths = new Set(
    (input.materials as Array<Record<string, unknown>>)
      .filter((material) => material.kind === "verifier")
      .map((material) => material.path as string),
  );
  for (const control of RUN_MODES) {
    const command = input.verifier[control] as unknown as VerifierCommand;
    if (!commandReferencesVerifierMaterial(command, verifierPaths))
      throw new Error(
        `verifier.${control} must reference an exact normalized path of a locked verifier material`,
      );
  }
  digestField(input.packageDigest, "packageDigest");
  if (input.packageDigest !== packageDigest(input as unknown as AcceptancePackage))
    throw new Error("packageDigest does not match package contents");
  return input as unknown as AcceptancePackage;
}
export async function readPackage(path: string): Promise<AcceptancePackage> {
  return validatePackage(JSON.parse(await readFile(path, "utf8")));
}
export async function readPackages(path: string): Promise<AcceptancePackage[]> {
  const info = await stat(path);
  if (info.isFile()) return [await readPackage(path)];
  if (!info.isDirectory()) throw new Error("package path must be a file or directory");
  const entries = await readdir(path, { withFileTypes: true });
  const packages: AcceptancePackage[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) packages.push(...(await readPackages(child)));
    else if (entry.isFile() && entry.name.endsWith(".json"))
      packages.push(await readPackage(child));
  }
  return packages;
}

async function envelopeMaterialInventory(
  envelopeId: string,
  executionRoot: string,
): Promise<string[]> {
  const root = await realpath(executionRoot).catch(() => {
    throw new Error("execution root is unavailable");
  });
  const materialRoot = `.continuity/envelopes/${envelopeId}`;
  let cursor = root;
  for (const segment of materialRoot.split("/")) {
    cursor = pathResolve(cursor, segment);
    let info;
    try {
      info = await lstat(cursor);
    } catch {
      throw new Error(`envelope material root is unavailable: ${materialRoot}`);
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(`envelope material root must contain only real directories: ${materialRoot}`);
  }

  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const child = pathResolve(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`envelope material tree contains a symbolic link: ${relative(root, child)}`);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        files.push(relative(root, child));
        if (files.length > 256) throw new Error("envelope material tree exceeds 256 files");
      } else {
        throw new Error(`envelope material tree contains a non-regular file: ${relative(root, child)}`);
      }
    }
  };
  await visit(cursor);
  return files.sort();
}

async function assertExactMaterialClosure(
  envelopeId: string,
  materials: LockedMaterial[],
  executionRoot: string,
): Promise<void> {
  const actual = await envelopeMaterialInventory(envelopeId, executionRoot);
  const declared = materials.map((material) => material.path).sort();
  const actualSet = new Set(actual);
  const declaredSet = new Set(declared);
  const undeclared = actual.filter((path) => !declaredSet.has(path));
  const unavailable = declared.filter((path) => !actualSet.has(path));
  if (undeclared.length || unavailable.length)
    throw new Error(
      `envelope material closure mismatch (undeclared: ${undeclared.join(", ") || "none"}; unavailable: ${unavailable.join(", ") || "none"})`,
    );
}

/**
 * Customer-local authoring helper. It inventories the envelope-owned material
 * tree, requires the draft to declare every regular file in that tree, writes
 * nothing, and returns the portable sealed package. The caller chooses whether
 * and where to persist it.
 */
export async function sealPackageDraft(
  input: unknown,
  executionRoot = process.cwd(),
): Promise<AcceptancePackage> {
  keysAre(input, ["schemaVersion", "envelope", "verifier", "materials"], "package draft");
  if (!Array.isArray(input.materials)) throw new Error("package draft materials must be an array");
  if (!input.envelope || typeof input.envelope !== "object" || Array.isArray(input.envelope))
    throw new Error("package draft envelope must be an object");
  const envelopeId = stringField(
    (input.envelope as Record<string, unknown>).id,
    "package draft envelope.id",
  );
  if (!/^env_[a-z0-9]{8,64}$/.test(envelopeId))
    throw new Error("package draft envelope.id is invalid");
  let root: string;
  try {
    root = await realpath(executionRoot);
  } catch {
    throw new Error("package draft execution root is unavailable");
  }
  const materials: LockedMaterial[] = [];
  for (const [index, material] of input.materials.entries()) {
    keysAre(material, ["path", "kind"], `package draft materials[${index}]`);
    const path = stringField(material.path, `package draft materials[${index}].path`);
    if (
      isAbsolute(path) ||
      path.includes("\\") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")
    )
      throw new Error(
        `package draft materials[${index}].path must be a normalized repository-relative path`,
      );
    if (!path.startsWith(`.continuity/envelopes/${envelopeId}/`))
      throw new Error(
        `package draft materials[${index}].path must be inside .continuity/envelopes/${envelopeId}`,
      );
    if (!["verifier", "fixture", "support"].includes(material.kind as string))
      throw new Error(`package draft materials[${index}].kind is invalid`);
    let resolved: string;
    try {
      resolved = await realpath(pathResolve(root, path));
    } catch {
      throw new Error(`package draft material is unavailable: ${path}`);
    }
    const relativePath = relative(root, resolved);
    if (relativePath.startsWith("..") || isAbsolute(relativePath))
      throw new Error(`package draft material escapes the repository root: ${path}`);
    const info = await stat(resolved);
    if (!info.isFile() || info.size > 16 * 1024 * 1024)
      throw new Error(`package draft material must be a file no larger than 16 MiB: ${path}`);
    const contents = await readFile(resolved);
    if (
      contents.includes(Buffer.from("BALLADEER_STARTER_VERIFIER")) ||
      isScaffoldVerifierSource(contents)
    )
      throw new Error("package draft still contains the scaffold verifier");
    if (contents.includes(Buffer.from('"replaceMe": true')))
      throw new Error("package draft still contains the scaffold fixture");
    materials.push({
      path,
      kind: material.kind as LockedMaterial["kind"],
      digest: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
    });
  }
  await assertExactMaterialClosure(envelopeId, materials, root);
  assertNoStarterPlaceholders(input.envelope, materials, "package draft");
  const base = {
    schemaVersion: input.schemaVersion,
    envelope: input.envelope,
    verifier: input.verifier,
    materials,
  } as Omit<AcceptancePackage, "packageDigest">;
  return validatePackage({ ...base, packageDigest: packageDigest(base) });
}

function assertNoStarterPlaceholders(
  envelope: unknown,
  materials: LockedMaterial[],
  label: string,
): void {
  const serialized = JSON.stringify(envelope);
  if (serialized.includes("REPLACE_WITH_") || /replace with|replace me/i.test(serialized))
    throw new Error(`${label} still contains scaffold placeholders; replace the approved meaning`);
  for (const material of materials) {
    if (!material.kind || !["verifier", "fixture", "support"].includes(material.kind)) continue;
    // These markers are generated only by `scaffold`; checking the locked
    // material itself prevents a placeholder verifier from being sealed even
    // when its package metadata has been edited.
    if (material.digest === sha256('{\n  "replaceMe": true\n}\n'))
      throw new Error(`${label} still contains the scaffold fixture`);
  }
}

/** Refuse to qualify a package that still contains the generated starter. */
export async function assertPackageReady(
  pkgInput: AcceptancePackage,
  executionRoot = process.cwd(),
): Promise<AcceptancePackage> {
  const pkg = validatePackage(pkgInput);
  await assertExactMaterialClosure(pkg.envelope.id, pkg.materials, executionRoot);
  const materials: LockedMaterial[] = [];
  for (const material of pkg.materials) {
    let contents: Buffer;
    try {
      contents = await readFile(pathResolve(executionRoot, material.path));
    } catch {
      throw new Error(`package material is unavailable: ${material.path}`);
    }
    if (
      contents.includes(Buffer.from("BALLADEER_STARTER_VERIFIER")) ||
      isScaffoldVerifierSource(contents)
    )
      throw new Error("package still contains the scaffold verifier");
    materials.push(material);
  }
  assertNoStarterPlaceholders(pkg.envelope, materials, "package");
  if (pkg.materials.some((material) => material.digest === sha256('{\n  "replaceMe": true\n}\n')))
    throw new Error("package still contains the scaffold fixture");
  return pkg;
}

function metadataField(value: unknown, label: string): string {
  return stringField(value, `qualification metadata.${label}`);
}

export function validateQualificationMetadata(input: unknown): QualificationMetadata {
  keysAre(
    input,
    ["schemaVersion", "workspaceLocator", "receiptId", "revisionId", "bindingId", "workflowDigest"],
    "qualification metadata",
  );
  if (input.schemaVersion !== "continuity-qualification-meta/v1")
    throw new Error("qualification metadata.schemaVersion is invalid");
  const workspaceLocator = metadataField(input.workspaceLocator, "workspaceLocator");
  const receiptId = metadataField(input.receiptId, "receiptId");
  const revisionId = metadataField(input.revisionId, "revisionId");
  const bindingId = metadataField(input.bindingId, "bindingId");
  const workflowDigest = digestField(input.workflowDigest, "qualification metadata.workflowDigest");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(workspaceLocator)
  )
    throw new Error("qualification metadata.workspaceLocator must be a UUID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(receiptId))
    throw new Error("qualification metadata.receiptId must be a UUID");
  if (!/^rev_[a-z0-9]{8,64}$/.test(revisionId))
    throw new Error("qualification metadata.revisionId is invalid");
  if (!/^bind_[a-z0-9]{8,64}$/.test(bindingId))
    throw new Error("qualification metadata.bindingId is invalid");
  return {
    schemaVersion: input.schemaVersion,
    workspaceLocator,
    receiptId,
    revisionId,
    bindingId,
    workflowDigest,
  };
}

function githubQualificationMetadata(metadata: QualificationMetadata): QualificationMetadata & {
  repository: string;
  repositoryId: string;
  ref: string;
  workflow: string;
  workflowRef: string;
  workflowSha: string;
  runId: string;
  runAttempt: number;
  event: string;
  targetSha: string;
  sourceSha: string;
  recordedAt: string;
} {
  const env = process.env;
  const required = (name: string): string => {
    const value = env[name];
    if (!value?.trim()) throw new Error(`qualification publisher requires ${name}`);
    return value;
  };
  const runAttempt = Number(required("GITHUB_RUN_ATTEMPT"));
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1)
    throw new Error("qualification publisher requires a positive GITHUB_RUN_ATTEMPT");
  const sourceSha = required("GITHUB_SHA");
  if (!isGitSha(sourceSha)) throw new Error("qualification publisher requires an exact GITHUB_SHA");
  return {
    ...metadata,
    repository: required("GITHUB_REPOSITORY"),
    repositoryId: required("GITHUB_REPOSITORY_ID"),
    ref: required("GITHUB_REF"),
    workflow: required("GITHUB_WORKFLOW"),
    workflowRef: required("GITHUB_WORKFLOW_REF"),
    workflowSha: required("GITHUB_WORKFLOW_SHA"),
    runId: required("GITHUB_RUN_ID"),
    runAttempt,
    event: required("GITHUB_EVENT_NAME"),
    targetSha: sourceSha,
    sourceSha,
    recordedAt: new Date().toISOString(),
  };
}

export async function buildQualificationRequest(
  pkgInput: AcceptancePackage,
  metadataInput: unknown,
  executionRoot = process.cwd(),
): Promise<Record<string, unknown>> {
  const pkg = await assertPackageReady(pkgInput, executionRoot);
  const metadata = githubQualificationMetadata(validateQualificationMetadata(metadataInput));
  const results = await runAll(pkg, executionRoot, metadata.sourceSha);
  const byControl = new Map(results.map((result) => [result.control, result]));
  const tamper = await runTamperControl(pkg, executionRoot, metadata.sourceSha);
  const result = (control: Control) => {
    const item = byControl.get(control);
    if (!item) throw new Error(`qualification result is missing ${control}`);
    // The local runner reports whether the control's expectation passed. The
    // qualification API records the observed behavior: the known-bad control
    // is therefore represented as `fail` when its expected non-zero command
    // exited as expected.
    const observedOutcome = item.outcome === "custody-invalid" ? "unknown" : item.outcome;
    const outcome =
      control === "bad" && observedOutcome === "pass"
        ? "fail"
        : control === "bad" && observedOutcome === "fail"
          ? "pass"
          : observedOutcome;
    return { outcome, resultDigest: item.resultDigest };
  };
  return {
    schemaVersion: "continuity-qualification/v1",
    receiptId: metadata.receiptId,
    workspaceLocator: metadata.workspaceLocator,
    repository: metadata.repository,
    repositoryId: metadata.repositoryId,
    ref: metadata.ref,
    workflow: metadata.workflow,
    workflowRef: metadata.workflowRef,
    workflowSha: metadata.workflowSha,
    runId: metadata.runId,
    runAttempt: metadata.runAttempt,
    event: metadata.event,
    targetSha: metadata.targetSha,
    sourceSha: metadata.sourceSha,
    revisionId: metadata.revisionId,
    semanticDigest: pkg.envelope.semanticDigest,
    bindingId: metadata.bindingId,
    packageDigest: pkg.packageDigest,
    verifierDigest: lockedMaterialsDigest(pkg, ["verifier"]),
    fixturesDigest: lockedMaterialsDigest(pkg, ["fixture"]),
    workflowDigest: metadata.workflowDigest,
    recordedAt: metadata.recordedAt,
    controls: { good: result("good"), bad: result("bad"), refactor: result("refactor"), tamper },
  };
}

/**
 * Create a local, intentionally incomplete authoring starter. The generated
 * verifier is only a control-shape example; the customer must replace it with
 * a verifier for the approved behavior before sealing or activating anything.
 * Every generated path is inside the requested repository-relative directory,
 * and existing files are never overwritten.
 */
export async function scaffoldPackage(
  outputPath: string,
  envelopeId = "env_example01",
  executionRoot = process.cwd(),
): Promise<ScaffoldResult> {
  if (outputPath !== ".continuity")
    throw new Error("scaffold output must be the repository-local .continuity directory");
  if (!/^env_[a-z0-9]{8,64}$/.test(envelopeId))
    throw new Error("scaffold envelope id must match env_[a-z0-9]{8,64}");
  const root = await realpath(executionRoot).catch(() => {
    throw new Error("scaffold execution root is unavailable");
  });
  const destination = pathResolve(root, outputPath);
  const relativeDestination = relative(root, destination);
  if (
    !relativeDestination ||
    relativeDestination.startsWith("..") ||
    isAbsolute(relativeDestination)
  )
    throw new Error("scaffold output escapes the repository root");
  try {
    const info = await lstat(destination);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("scaffold output must be a real directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(destination, { recursive: true });
  }

  const envelopeRoot = `${outputPath}/envelopes/${envelopeId}`;
  const verifierPath = `${envelopeRoot}/verifier.mjs`;
  const fixturePath = `${envelopeRoot}/fixture.json`;
  const draftPath = `${outputPath}/drafts/${envelopeId}.json`;
  const readmePath = `${outputPath}/README.md`;
  const paths = [verifierPath, fixturePath, draftPath, readmePath];
  for (const path of paths) {
    const resolved = pathResolve(root, path);
    const relativePath = relative(root, resolved);
    if (relativePath.startsWith("..") || isAbsolute(relativePath))
      throw new Error(`scaffold path escapes the repository root: ${path}`);
    try {
      await lstat(resolved);
      throw new Error(`scaffold refuses to overwrite existing file: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const meaning = {
    id: envelopeId,
    title: "Replace with the customer promise",
    beneficiary: "Replace with the person or system that benefits",
    trigger: "Replace with the observable trigger",
    preconditions: ["Replace with a concrete precondition"],
    observableOutcome: "Replace with the observable outcome",
    allowedVariations: ["Replace with allowed implementation variation"],
    nonGoals: ["Replace with an explicit non-goal"],
    passingExamples: [
      {
        label: "replace me",
        setup: "Describe a valid setup",
        expectedOutcome: "Describe the outcome",
      },
    ],
    failingExamples: [
      {
        label: "replace me",
        setup: "Describe a known-bad setup",
        expectedOutcome: "Describe the failure",
      },
    ],
    refactorExamples: [
      {
        label: "replace me",
        setup: "Describe a behavior-preserving refactor",
        expectedOutcome: "The customer outcome remains unchanged",
      },
    ],
    scope: {
      repositoryId: "REPLACE_WITH_BALLADEER_REPOSITORY_ID",
      surfaces: ["REPLACE_WITH_BEHAVIORAL_SURFACE"],
      labels: [],
    },
  };
  const draft = {
    schemaVersion: RUNNER_SCHEMA,
    envelope: {
      ...meaning,
      semanticDigest: sha256(canonicalize(semanticMeaning(meaning as unknown as EnvelopeMeaning))),
      ownerId: "REPLACE_WITH_OWNER_ID",
    },
    verifier: {
      target: { executable: "node", args: [verifierPath, "target"] },
      good: { executable: "node", args: [verifierPath, "good"] },
      bad: { executable: "node", args: [verifierPath, "bad"] },
      refactor: { executable: "node", args: [verifierPath, "refactor"] },
    },
    materials: [
      { path: verifierPath, kind: "verifier" as const },
      { path: fixturePath, kind: "fixture" as const },
    ],
  };
  const verifier = `const control = process.argv[2];\n// BALLADEER_STARTER_VERIFIER: replace this with a real customer-behavior verifier.\nprocess.exit(control === "bad" ? 1 : 0);\n`;
  const fixture = '{\n  "replaceMe": true\n}\n';
  const readme = `# Continuity starter\n\nThis directory was generated locally for **${envelopeId}**. It is an authoring starter, not a protected behavior.\n\n1. Replace every placeholder in drafts/${envelopeId}.json.\n2. Replace envelopes/${envelopeId}/verifier.mjs with a real verifier and update envelopes/${envelopeId}/fixture.json. The starter verifier only demonstrates control wiring.\n3. From the repository root, seal it into ${outputPath}/packages/${envelopeId}.json:\n\n   continuity-runner seal ${draftPath} ${outputPath}/packages/${envelopeId}.json\n\nThe seal command refuses to overwrite an existing output. Run the local qualification controls before asking the Balladeer owner to activate the package. No source, fixture contents, or verifier output is sent to Balladeer; only closed digests and normalized outcomes are publishable.\n`;
  await mkdir(pathResolve(root, envelopeRoot), { recursive: true });
  await mkdir(pathResolve(root, `${outputPath}/drafts`), { recursive: true });
  await mkdir(pathResolve(root, `${outputPath}/packages`), { recursive: true });
  for (const [path, contents] of [
    [verifierPath, verifier],
    [fixturePath, fixture],
    [draftPath, JSON.stringify(draft, null, 2) + "\n"],
    [readmePath, readme],
  ] as const)
    await writeFile(pathResolve(root, path), contents, { encoding: "utf8", flag: "wx" });
  return { root: destination, draftPath, verifierPath, fixturePath, readmePath };
}

export function validateExecutionManifest(input: unknown): ExecutionManifest {
  keysAre(
    input,
    ["schemaVersion", "targetId", "generatedAt", "envelopes", "manifestDigest"],
    "manifest",
  );
  if (input.schemaVersion !== "continuity-ci/v1")
    throw new Error("manifest.schemaVersion is invalid");
  stringField(input.targetId, "manifest.targetId");
  stringField(input.generatedAt, "manifest.generatedAt");
  if (Number.isNaN(Date.parse(input.generatedAt as string)))
    throw new Error("manifest.generatedAt is invalid");
  if (!Array.isArray(input.envelopes)) throw new Error("manifest.envelopes must be an array");
  const seen = new Set<string>();
  for (const entry of input.envelopes) {
    keysAre(entry, ["id", "packageDigest"], "manifest envelope");
    stringField(entry.id, "manifest envelope id");
    digestField(entry.packageDigest, "manifest packageDigest");
    if (seen.has(entry.id as string)) throw new Error("manifest has duplicate envelope id");
    seen.add(entry.id as string);
  }
  digestField(input.manifestDigest, "manifest.manifestDigest");
  const { manifestDigest: _digest, ...base } = input;
  if (input.manifestDigest !== sha256(canonicalize(base)))
    throw new Error("manifestDigest does not match manifest contents");
  return input as unknown as ExecutionManifest;
}

export function selectManifestPackages(
  packages: AcceptancePackage[],
  manifestInput: ExecutionManifest,
): AcceptancePackage[] {
  const manifest = validateExecutionManifest(manifestInput);
  const byId = new Map<string, AcceptancePackage>();
  for (const pkg of packages) {
    if (byId.has(pkg.envelope.id)) throw new Error("package directory has duplicate envelope id");
    byId.set(pkg.envelope.id, pkg);
  }
  return manifest.envelopes.map((entry) => {
    const pkg = byId.get(entry.id);
    if (!pkg) throw new Error(`required package is missing: ${entry.id}`);
    if (pkg.packageDigest !== entry.packageDigest)
      throw new Error(`required package digest changed: ${entry.id}`);
    return pkg;
  });
}

function digestStream(value: string): string {
  return sha256(value);
}
function expectedFor(control: RunMode, exitCode: number | null): boolean {
  return control === "bad" ? exitCode !== 0 : exitCode === 0;
}
function resultDigest(result: Omit<RunResult, "resultDigest"> | RunResult): string {
  return sha256(canonicalize(resultWithoutDigest(result as RunResult)));
}

export function lockedMaterialsDigest(
  pkgInput: AcceptancePackage,
  kinds: LockedMaterial["kind"][] = ["verifier", "fixture", "support"],
): string {
  const pkg = validatePackage(pkgInput);
  const selected = pkg.materials
    .filter((material) => kinds.includes(material.kind))
    .map((material) => ({ path: material.path, kind: material.kind, digest: material.digest }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return sha256(canonicalize(selected));
}

export async function verifyLockedMaterials(
  pkgInput: AcceptancePackage,
  executionRoot = process.cwd(),
): Promise<boolean> {
  const pkg = validatePackage(pkgInput);
  try {
    await assertExactMaterialClosure(pkg.envelope.id, pkg.materials, executionRoot);
    const root = await realpath(executionRoot);
    for (const material of pkg.materials) {
      const resolved = await realpath(pathResolve(root, material.path));
      const relativePath = relative(root, resolved);
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) return false;
      const info = await stat(resolved);
      if (!info.isFile() || info.size > 16 * 1024 * 1024) return false;
      const contents = await readFile(resolved);
      const actual = `sha256:${createHash("sha256").update(contents).digest("hex")}`;
      if (actual !== material.digest) return false;
    }
  } catch {
    return false;
  }
  return true;
}

export function validateResult(input: unknown): RunResult {
  keysAre(input, resultKeys, "result");
  if (input.schemaVersion !== RUNNER_SCHEMA)
    throw new Error(`result.schemaVersion must be ${RUNNER_SCHEMA}`);
  if (!RUN_MODES.includes(input.control as RunMode)) throw new Error("result.control is invalid");
  if (!["pass", "fail", "unknown", "canceled", "custody-invalid"].includes(input.outcome as string))
    throw new Error("result.outcome is invalid");
  stringField(input.envelopeId, "result.envelopeId");
  digestField(input.packageDigest, "result.packageDigest");
  if (!isGitSha(input.sourceSha))
    throw new Error("result.sourceSha must be an exact 40-hex commit SHA");
  for (const key of ["runnerVersion", "startedAt", "completedAt", "custody"])
    stringField(input[key], `result.${key}`);
  digestField(input.stdoutDigest, "result.stdoutDigest");
  digestField(input.stderrDigest, "result.stderrDigest");
  digestField(input.resultDigest, "result.resultDigest");
  if (input.custody !== "local" && input.custody !== "invalid")
    throw new Error("result.custody is invalid");
  if (
    typeof input.durationMs !== "number" ||
    !Number.isSafeInteger(input.durationMs) ||
    input.durationMs < 0
  )
    throw new Error("result.durationMs is invalid");
  if (input.exitCode !== null && !Number.isSafeInteger(input.exitCode))
    throw new Error("result.exitCode is invalid");
  if (input.resultDigest !== resultDigest(input as unknown as RunResult))
    throw new Error("resultDigest does not match result contents");
  return input as unknown as RunResult;
}

/**
 * Customer verifiers are untrusted processes. They need a minimal operating
 * environment, not the Actions control plane: in particular they must never
 * inherit OIDC, GitHub file-command, artifact, runner, or checkout metadata.
 * There is intentionally no package-level arbitrary env passthrough.
 */
export function verifierEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "SYSTEMROOT",
  ];
  const clean: Record<string, string> = {};
  for (const key of allowed) {
    const value = environment[key];
    if (typeof value === "string" && value.length > 0) clean[key] = value;
  }
  return clean;
}

export async function runVerifier(
  pkgInput: AcceptancePackage,
  control: RunMode,
  executionRoot = process.cwd(),
  sourceSha = process.env.BALLADEER_SOURCE_SHA ?? process.env.GITHUB_SHA,
): Promise<RunResult> {
  const pkg = validatePackage(pkgInput);
  if (!isGitSha(sourceSha)) throw new Error("sourceSha must be an exact 40-hex commit SHA");
  const spec = pkg.verifier[control];
  const started = new Date();
  if (!(await verifyLockedMaterials(pkg, executionRoot)))
    return closedResult(pkg, control, started, sourceSha, "custody-invalid", null, "invalid");
  const timeout = spec.timeoutMs ?? 120_000;
  let root: string;
  let cwd: string;
  try {
    root = await realpath(executionRoot);
    cwd = await realpath(pathResolve(root, spec.cwd ?? "."));
  } catch {
    return closedResult(pkg, control, started, sourceSha, "custody-invalid", null, "invalid");
  }
  const relativeCwd = relative(root, cwd);
  if (relativeCwd.startsWith("..") || isAbsolute(relativeCwd)) {
    return closedResult(pkg, control, started, sourceSha, "custody-invalid", null, "invalid");
  }
  return new Promise((settle) => {
    const outputLimit = 1_048_576;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    let settled = false;
    let exited = false;
    let forcedOutcome: RunOutcome | undefined;
    const child = spawn(spec.executable, spec.args, {
      cwd,
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: verifierEnvironment(),
    });
    const terminateGroup = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            // The process has already exited.
          }
        }
      }
    };
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (outcome: RunOutcome) => {
      forcedOutcome ??= outcome;
      terminateGroup("SIGTERM");
      killTimer ??= setTimeout(() => terminateGroup("SIGKILL"), 250);
    };
    const updateOutput = (chunk: Buffer, stream: "stdout" | "stderr") => {
      if (stream === "stdout") {
        stdoutBytes += chunk.byteLength;
        stdoutHash.update(chunk);
        if (stdoutBytes > outputLimit) stop("unknown");
      } else {
        stderrBytes += chunk.byteLength;
        stderrHash.update(chunk);
        if (stderrBytes > outputLimit) stop("unknown");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => updateOutput(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => updateOutput(chunk, "stderr"));
    const timer = setTimeout(() => stop("unknown"), timeout);
    const finish = (outcome: RunOutcome, exitCode: number | null) => {
      if (settled || !exited) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const completed = new Date();
      const base: Omit<RunResult, "resultDigest"> = {
        schemaVersion: RUNNER_SCHEMA,
        runnerVersion: RUNNER_VERSION,
        envelopeId: pkg.envelope.id,
        packageDigest: pkg.packageDigest,
        sourceSha,
        control,
        outcome,
        exitCode,
        durationMs: Math.max(0, completed.getTime() - started.getTime()),
        stdoutDigest: `sha256:${stdoutHash.digest("hex")}`,
        stderrDigest: `sha256:${stderrHash.digest("hex")}`,
        startedAt: started.toISOString(),
        completedAt: completed.toISOString(),
        custody: "local",
      };
      settle({ ...base, resultDigest: resultDigest(base) });
    };
    child.once("error", () => {
      forcedOutcome ??= "unknown";
      exited = true;
      finish("unknown", null);
    });
    child.once("exit", (code, signal) => {
      exited = true;
      const outcome =
        forcedOutcome ??
        (signal
          ? signal === "SIGTERM"
            ? "unknown"
            : "canceled"
          : expectedFor(control, code)
            ? "pass"
            : "fail");
      finish(outcome, code);
    });
  });
}
function closedResult(
  pkg: AcceptancePackage,
  control: RunMode,
  started: Date,
  sourceSha: string,
  outcome: RunOutcome,
  exitCode: number | null,
  custody: RunResult["custody"],
): RunResult {
  const completed = new Date();
  const base: Omit<RunResult, "resultDigest"> = {
    schemaVersion: RUNNER_SCHEMA,
    runnerVersion: RUNNER_VERSION,
    envelopeId: pkg.envelope.id,
    packageDigest: pkg.packageDigest,
    sourceSha,
    control,
    outcome,
    exitCode,
    durationMs: Math.max(0, completed.getTime() - started.getTime()),
    stdoutDigest: sha256(""),
    stderrDigest: sha256(""),
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    custody,
  };
  return { ...base, resultDigest: resultDigest(base) };
}

export async function runOne(
  pkgInput: AcceptancePackage,
  control: RunMode,
  executionRoot = process.cwd(),
  sourceSha = process.env.BALLADEER_SOURCE_SHA ?? process.env.GITHUB_SHA,
): Promise<RunResult> {
  return runVerifier(pkgInput, control, executionRoot, sourceSha);
}
export async function runAll(
  pkgInput: AcceptancePackage,
  executionRoot = process.cwd(),
  sourceSha = process.env.BALLADEER_SOURCE_SHA ?? process.env.GITHUB_SHA,
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const control of CONTROLS)
    results.push(await runVerifier(pkgInput, control, executionRoot, sourceSha));
  return results;
}
export async function runAllPackages(
  packages: AcceptancePackage[],
  executionRoot = process.cwd(),
  sourceSha = process.env.BALLADEER_SOURCE_SHA ?? process.env.GITHUB_SHA,
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const pkg of packages) results.push(...(await runAll(pkg, executionRoot, sourceSha)));
  return results;
}
export async function runTarget(
  pkgInput: AcceptancePackage,
  executionRoot = process.cwd(),
  sourceSha = process.env.BALLADEER_SOURCE_SHA ?? process.env.GITHUB_SHA,
): Promise<RunResult> {
  return runVerifier(pkgInput, "target", executionRoot, sourceSha);
}
export async function runTargetPackages(
  packages: AcceptancePackage[],
  executionRoot = process.cwd(),
  sourceSha = process.env.BALLADEER_SOURCE_SHA ?? process.env.GITHUB_SHA,
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const pkg of packages)
    results.push(await runTarget(pkg, executionRoot, sourceSha));
  return results;
}

/**
 * Exercise the actual local custody boundary by changing one locked material,
 * running the verifier, and restoring the bytes before returning. The result
 * exposes only an outcome and digest; it never serializes the changed file.
 */
export async function runTamperControl(
  pkgInput: AcceptancePackage,
  executionRoot = process.cwd(),
  sourceSha = process.env.BALLADEER_SOURCE_SHA ?? process.env.GITHUB_SHA,
): Promise<TamperControlResult> {
  const pkg = validatePackage(pkgInput);
  const material = pkg.materials.find((item) => item.kind === "verifier") ?? pkg.materials[0];
  if (!material) throw new Error("package has no locked materials");
  let root: string;
  try {
    root = await realpath(executionRoot);
    const resolved = await realpath(pathResolve(root, material.path));
    const relativePath = relative(root, resolved);
    if (relativePath.startsWith("..") || isAbsolute(relativePath))
      throw new Error("tamper material escapes the repository root");
    const original = await readFile(resolved);
    await writeFile(resolved, Buffer.concat([original, Buffer.from("\nBALLADEER_TAMPER_PROBE\n")]));
    try {
      const observed = await runVerifier(pkg, "good", root, sourceSha);
      return {
        envelopeId: pkg.envelope.id,
        outcome: observed.custody === "invalid" ? "detected" : "not_detected",
        resultDigest: observed.resultDigest,
      };
    } finally {
      await writeFile(resolved, original);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "tamper material escapes the repository root")
      throw error;
    return {
      envelopeId: pkg.envelope.id,
      outcome: "unknown",
      resultDigest: sha256(`tamper-control-error:${pkg.envelope.id}`),
    };
  }
}

export async function runTamperControls(
  packages: AcceptancePackage[],
  executionRoot = process.cwd(),
  sourceSha = process.env.BALLADEER_SOURCE_SHA ?? process.env.GITHUB_SHA,
): Promise<TamperControlResult[]> {
  const controls: TamperControlResult[] = [];
  for (const pkg of packages) controls.push(await runTamperControl(pkg, executionRoot, sourceSha));
  return controls;
}
export function exercisePasses(results: RunResult[]): boolean {
  const envelopeIds = new Set(results.map((result) => result.envelopeId));
  return (
    envelopeIds.size > 0 &&
    [...envelopeIds].every((envelopeId) =>
      CONTROLS.every(
        (control) =>
          results.filter((result) => result.envelopeId === envelopeId && result.control === control)
            .length === 1 &&
          results.some(
            (result) =>
              result.envelopeId === envelopeId &&
              result.control === control &&
              result.outcome === "pass",
          ),
      ),
    )
  );
}

export function detectsPackageTampering(pkgInput: AcceptancePackage): boolean {
  const pkg = validatePackage(pkgInput);
  const changed = structuredClone(pkg);
  changed.envelope.title = `${changed.envelope.title} (tampered)`;
  try {
    validatePackage(changed);
    return false;
  } catch {
    return true;
  }
}

export function detectsVerifierTampering(pkgInput: AcceptancePackage): boolean {
  const pkg = validatePackage(pkgInput);
  const changed = structuredClone(pkg);
  const verifierMaterial = changed.materials.find((material) => material.kind === "verifier");
  if (!verifierMaterial) return false;
  verifierMaterial.digest = `sha256:${"0".repeat(64)}`;
  try {
    validatePackage(changed);
    return false;
  } catch {
    return true;
  }
}

export function qualificationSummary(
  packages: AcceptancePackage[],
  results: RunResult[],
  tamperControls: TamperControlResult[] = [],
): {
  sourceSha: string;
  sourceShaConsistent: boolean;
  allControlsPassed: boolean;
  packageTamperDetected: boolean;
  verifierTamperDetected: boolean;
  tamperDetected: boolean;
  custody: "customer-local-unattested";
  perEnvelope: {
    envelopeId: string;
    controlsPassed: boolean;
    packageTamperDetected: boolean;
    verifierTamperDetected: boolean;
    verifierDigest: string;
    fixturesDigest: string;
    materialsDigest: string;
  }[];
} {
  const perEnvelope = packages.map((pkg) => {
    const ownResults = results.filter((result) => result.envelopeId === pkg.envelope.id);
    const tamper = tamperControls.find((item) => item.envelopeId === pkg.envelope.id);
    // A metadata mutation is not an executed tamper control. Qualification
    // must be based on the real material mutation exercised by
    // `qualification-request`; callers that did not run it stay unknown.
    const tamperDetected = tamper?.outcome === "detected";
    return {
      envelopeId: pkg.envelope.id,
      controlsPassed: exercisePasses(ownResults),
      packageTamperDetected: tamperDetected,
      verifierTamperDetected: tamperDetected,
      tamperDetected,
      verifierDigest: lockedMaterialsDigest(pkg, ["verifier"]),
      fixturesDigest: lockedMaterialsDigest(pkg, ["fixture"]),
      materialsDigest: lockedMaterialsDigest(pkg),
    };
  });
  const sourceShas = new Set(results.map((result) => result.sourceSha));
  const sourceSha = results[0]?.sourceSha ?? "";
  const sourceShaConsistent = sourceShas.size === 1 && isGitSha(sourceSha);
  return {
    sourceSha,
    sourceShaConsistent,
    allControlsPassed: sourceShaConsistent && perEnvelope.every((item) => item.controlsPassed),
    packageTamperDetected: perEnvelope.every((item) => item.packageTamperDetected),
    verifierTamperDetected: perEnvelope.every((item) => item.verifierTamperDetected),
    tamperDetected: perEnvelope.every((item) => item.tamperDetected),
    custody: "customer-local-unattested",
    perEnvelope,
  };
}
export function createOffboardingExport(pkgInput: AcceptancePackage, results: RunResult[] = []) {
  const pkg = validatePackage(pkgInput);
  results.forEach(validateResult);
  return {
    schemaVersion: RUNNER_SCHEMA,
    exportedAt: new Date().toISOString(),
    package: pkg,
    results,
    runnable: true,
  };
}
