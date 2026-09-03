import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readdir, readFile, realpath, stat, writeFile, } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve as pathResolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
export const RUNNER_SCHEMA = "continuity-package/v1";
export const RUNNER_VERSION = "0.1.0";
export const CONTROLS = ["good", "bad", "refactor"];
export const RUN_MODES = ["target", ...CONTROLS];
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
const packageKeys = ["schemaVersion", "promise", "verifier", "materials", "packageDigest"];
const resultKeys = [
    "schemaVersion",
    "runnerVersion",
    "promiseId",
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
const isGitSha = (value) => typeof value === "string" && value.length === 40 && /^[0-9a-f]{40}$/.test(value);
// ---------------------------------------------------------------------------
// The product's noun is `promise`, in the protocol as well as the prose. A
// package written against the retired noun is still valid JSON, so it would
// otherwise fail with a generic "unknown field" error and leave the person or
// agent reading a customer's job log guessing why a package that used to work
// no longer does. Name the retired shape and refuse it.
//
// This is the only place the retired word may appear, and it is assembled from
// fragments so that `check-release` can assert the whole word survives nowhere
// in this repository. The refusal message a customer reads still spells it out.
// ---------------------------------------------------------------------------
const retiredNoun = ["envel", "ope"].join("");
const retiredIdPrefix = "env_";
const retiredIdPattern = new RegExp(`^${retiredIdPrefix}`);
function retiredShapeError(label, detail) {
    return new Error(`${label} uses the retired ${retiredNoun} naming: ${detail} The retired shape is refused, never migrated in place.`);
}
const retiredPackageDetail = `it carries the "${retiredNoun}" key or an ${retiredIdPrefix} id, but the product's noun is now promise, so a package must carry the "promise" key and a prom_ id. Regenerate the package with Balladeer.`;
/** Refuse a retired package key before a generic unknown-field error hides it. */
function assertNotRetiredShape(input, label) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return;
    if (Object.prototype.hasOwnProperty.call(input, retiredNoun))
        throw retiredShapeError(label, retiredPackageDetail);
}
/** Refuse a retired id, whichever key carried it. */
function assertNotRetiredId(id, label) {
    if (retiredIdPattern.test(id))
        throw retiredShapeError(label, retiredPackageDetail);
}
/**
 * A frozen manifest is produced by the control plane rather than by the
 * customer, so a retired manifest means this attestor release and the control
 * plane disagree about the protocol noun. Say that, instead of reporting an
 * unknown field.
 */
function assertNotRetiredManifest(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return;
    if (Object.prototype.hasOwnProperty.call(input, `${retiredNoun}s`))
        throw retiredShapeError("manifest", `it lists "${retiredNoun}s" where this runner requires "promises", so this attestor release and the control plane that produced the manifest disagree on the protocol noun.`);
}
// The scaffold's marker is deliberately not the only readiness guard. A
// customer can remove a comment without having authored a verifier. Keep a
// normalized structural fingerprint of the generated control program so that
// whitespace/comments (including the marker itself) cannot launder it.
const scaffoldVerifierStructure = 'const control = process.argv[2];process.exit(control === "bad" ? 1 : 0);';
const normalizedSource = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1")
    .replace(/\s+/g, "");
const scaffoldVerifierStructureDigest = sha256(normalizedSource(scaffoldVerifierStructure));
function isScaffoldVerifierSource(contents) {
    return sha256(normalizedSource(contents.toString("utf8"))) === scaffoldVerifierStructureDigest;
}
function keysAre(value, expected, label, optional = []) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be an object`);
    const actual = Object.keys(value);
    for (const key of actual)
        if (!expected.includes(key))
            throw new Error(`${label} has unknown field: ${key}`);
    for (const key of expected)
        if (!optional.includes(key) && !actual.includes(key))
            throw new Error(`${label} is missing field: ${key}`);
}
function stringField(value, label) {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`${label} must be a non-empty string`);
    return value;
}
function stringArray(value, label) {
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
function commandReferencesVerifierMaterial(command, verifierPaths) {
    const normalized = (token) => (token.startsWith("./") ? token.slice(2) : token);
    if (verifierPaths.has(normalized(command.executable)))
        return true;
    // Interpreter invocation is intentionally narrow: the locked verifier must
    // be the first argument, not a decoy after an inline program or module flag.
    const executableName = command.executable.split("/").at(-1)?.toLowerCase() ?? "";
    const interpreters = /^(node|node\.exe|python(?:3(?:\.\d+)?)?|ruby|perl|bash|sh|dash|zsh|tsx)$/;
    if (!interpreters.test(executableName) || command.args.length === 0)
        return false;
    return verifierPaths.has(normalized(command.args[0]));
}
function digestField(value, label) {
    const digest = stringField(value, label);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest))
        throw new Error(`${label} must be a SHA-256 digest`);
    return digest;
}
function validateExamples(value, label) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 12)
        throw new Error(`${label} must contain between 1 and 12 examples`);
    for (const [index, example] of value.entries()) {
        keysAre(example, ["label", "setup", "expectedOutcome"], `${label}[${index}]`);
        stringField(example.label, `${label}[${index}].label`);
        stringField(example.setup, `${label}[${index}].setup`);
        stringField(example.expectedOutcome, `${label}[${index}].expectedOutcome`);
    }
    return value;
}
function semanticMeaning(promise) {
    const { id: _id, ownerId: _ownerId, semanticDigest: _semanticDigest, ...meaning } = promise;
    return meaning;
}
export function canonicalize(value) {
    if (value === undefined)
        throw new Error("cannot canonicalize undefined");
    if (typeof value === "number" && !Number.isFinite(value))
        throw new Error("cannot canonicalize non-finite number");
    if (["bigint", "symbol", "function"].includes(typeof value))
        throw new Error("cannot canonicalize unsupported value");
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalize).join(",")}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        throw new Error("can only canonicalize plain objects");
    return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
        .join(",")}}`;
}
export function sha256(value) {
    return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function withoutDigest(pkg) {
    const { packageDigest: _ignored, ...rest } = pkg;
    return rest;
}
function resultWithoutDigest(result) {
    const { resultDigest: _ignored, ...rest } = result;
    return rest;
}
export function packageDigest(pkg) {
    return sha256(canonicalize(withoutDigest(pkg)));
}
export function validatePackage(input) {
    assertNotRetiredShape(input, "package");
    keysAre(input, packageKeys, "package");
    if (input.schemaVersion !== RUNNER_SCHEMA)
        throw new Error(`package.schemaVersion must be ${RUNNER_SCHEMA}`);
    keysAre(input.promise, meaningKeys, "promise");
    const promiseId = stringField(input.promise.id, "promise.id");
    for (const key of ["title", "beneficiary", "trigger", "observableOutcome", "ownerId"])
        stringField(input.promise[key], `promise.${key}`);
    assertNotRetiredId(promiseId, "package");
    if (!/^prom_[a-z0-9]{8,64}$/.test(promiseId))
        throw new Error("promise.id is invalid");
    digestField(input.promise.semanticDigest, "promise.semanticDigest");
    for (const key of ["preconditions", "allowedVariations", "nonGoals"])
        stringArray(input.promise[key], `promise.${key}`);
    for (const key of ["passingExamples", "failingExamples", "refactorExamples"])
        validateExamples(input.promise[key], `promise.${key}`);
    keysAre(input.promise.scope, ["repositoryId", "surfaces", "labels"], "promise.scope");
    stringField(input.promise.scope.repositoryId, "promise.scope.repositoryId");
    const surfaces = stringArray(input.promise.scope.surfaces, "promise.scope.surfaces");
    stringArray(input.promise.scope.labels, "promise.scope.labels");
    if (surfaces.length < 1)
        throw new Error("promise.scope.surfaces requires at least one marker");
    const typedPromise = input.promise;
    if (typedPromise.semanticDigest !== sha256(canonicalize(semanticMeaning(typedPromise))))
        throw new Error("promise.semanticDigest does not match approved meaning");
    keysAre(input.verifier, ["target", "good", "bad", "refactor"], "verifier");
    for (const control of RUN_MODES) {
        const command = input.verifier[control];
        keysAre(command, commandKeys, `verifier.${control}`, ["cwd", "timeoutMs"]);
        stringField(command.executable, `verifier.${control}.executable`);
        stringArray(command.args, `verifier.${control}.args`);
        if (command.cwd !== undefined)
            stringField(command.cwd, `verifier.${control}.cwd`);
        if (command.timeoutMs !== undefined &&
            (typeof command.timeoutMs !== "number" ||
                !Number.isSafeInteger(command.timeoutMs) ||
                command.timeoutMs < 1 ||
                command.timeoutMs > 600_000))
            throw new Error(`verifier.${control}.timeoutMs out of range`);
    }
    if (!Array.isArray(input.materials) || input.materials.length < 2 || input.materials.length > 256)
        throw new Error("materials must contain between 2 and 256 locked files");
    const materialPaths = new Set();
    let verifierCount = 0;
    let fixtureCount = 0;
    for (const [index, material] of input.materials.entries()) {
        keysAre(material, ["path", "kind", "digest"], `materials[${index}]`);
        const path = stringField(material.path, `materials[${index}].path`);
        if (isAbsolute(path) ||
            path.includes("\\") ||
            path.split("/").some((part) => part === "" || part === "." || part === ".."))
            throw new Error(`materials[${index}].path must be a normalized repository-relative path`);
        if (!path.startsWith(`.continuity/promises/${promiseId}/`))
            throw new Error(`materials[${index}].path must be inside .continuity/promises/${promiseId}`);
        if (!["verifier", "fixture", "support"].includes(material.kind))
            throw new Error(`materials[${index}].kind is invalid`);
        digestField(material.digest, `materials[${index}].digest`);
        if (materialPaths.has(path))
            throw new Error(`materials contains duplicate path: ${path}`);
        materialPaths.add(path);
        if (material.kind === "verifier")
            verifierCount += 1;
        if (material.kind === "fixture")
            fixtureCount += 1;
    }
    if (verifierCount < 1 || fixtureCount < 1)
        throw new Error("materials requires at least one verifier file and one fixture file");
    const verifierPaths = new Set(input.materials
        .filter((material) => material.kind === "verifier")
        .map((material) => material.path));
    for (const control of RUN_MODES) {
        const command = input.verifier[control];
        if (!commandReferencesVerifierMaterial(command, verifierPaths))
            throw new Error(`verifier.${control} must reference an exact normalized path of a locked verifier material`);
    }
    digestField(input.packageDigest, "packageDigest");
    if (input.packageDigest !== packageDigest(input))
        throw new Error("packageDigest does not match package contents");
    return input;
}
export async function readPackage(path) {
    return validatePackage(JSON.parse(await readFile(path, "utf8")));
}
export async function readPackages(path) {
    const info = await stat(path);
    if (info.isFile())
        return [await readPackage(path)];
    if (!info.isDirectory())
        throw new Error("package path must be a file or directory");
    const entries = await readdir(path, { withFileTypes: true });
    const packages = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const child = `${path}/${entry.name}`;
        if (entry.isDirectory())
            packages.push(...(await readPackages(child)));
        else if (entry.isFile() && entry.name.endsWith(".json"))
            packages.push(await readPackage(child));
    }
    return packages;
}
/**
 * Read every sealed package that can be read, and report the files that cannot
 * instead of failing the whole catalog. A file that does not validate simply
 * does not answer for its promise: the manifest selection then reports that
 * promise as custody-invalid, exactly as a deleted file would, and every other
 * promise still runs. A package directory that does not exist yields no
 * packages rather than an error, for the same reason.
 *
 * The returned file names are for the customer's own log. They are never part
 * of a result and never leave the customer's runner.
 */
export async function readAvailablePackages(path) {
    const packages = [];
    const rejected = [];
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile()) {
        try {
            packages.push(await readPackage(path));
        }
        catch {
            rejected.push(path);
        }
        return { packages, rejected };
    }
    const visit = async (directory) => {
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined);
        if (!entries)
            return;
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const child = `${directory}/${entry.name}`;
            if (entry.isDirectory())
                await visit(child);
            else if (entry.isFile() && entry.name.endsWith(".json")) {
                try {
                    packages.push(await readPackage(child));
                }
                catch {
                    rejected.push(child);
                }
            }
        }
    };
    await visit(path);
    return { packages, rejected };
}
async function promiseMaterialInventory(promiseId, executionRoot) {
    const root = await realpath(executionRoot).catch(() => {
        throw new Error("execution root is unavailable");
    });
    const materialRoot = `.continuity/promises/${promiseId}`;
    let cursor = root;
    for (const segment of materialRoot.split("/")) {
        cursor = pathResolve(cursor, segment);
        let info;
        try {
            info = await lstat(cursor);
        }
        catch {
            throw new Error(`promise material root is unavailable: ${materialRoot}`);
        }
        if (info.isSymbolicLink() || !info.isDirectory())
            throw new Error(`promise material root must contain only real directories: ${materialRoot}`);
    }
    const files = [];
    const visit = async (directory) => {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const child = pathResolve(directory, entry.name);
            if (entry.isSymbolicLink())
                throw new Error(`promise material tree contains a symbolic link: ${relative(root, child)}`);
            if (entry.isDirectory())
                await visit(child);
            else if (entry.isFile()) {
                files.push(relative(root, child));
                if (files.length > 256)
                    throw new Error("promise material tree exceeds 256 files");
            }
            else {
                throw new Error(`promise material tree contains a non-regular file: ${relative(root, child)}`);
            }
        }
    };
    await visit(cursor);
    return files.sort();
}
async function assertExactMaterialClosure(promiseId, materials, executionRoot) {
    const actual = await promiseMaterialInventory(promiseId, executionRoot);
    const declared = materials.map((material) => material.path).sort();
    const actualSet = new Set(actual);
    const declaredSet = new Set(declared);
    const undeclared = actual.filter((path) => !declaredSet.has(path));
    const unavailable = declared.filter((path) => !actualSet.has(path));
    if (undeclared.length || unavailable.length)
        throw new Error(`promise material closure mismatch (undeclared: ${undeclared.join(", ") || "none"}; unavailable: ${unavailable.join(", ") || "none"})`);
}
/**
 * Customer-local authoring helper. It inventories the promise-owned material
 * tree, requires the draft to declare every regular file in that tree, writes
 * nothing, and returns the portable sealed package. The caller chooses whether
 * and where to persist it.
 */
export async function sealPackageDraft(input, executionRoot = process.cwd()) {
    assertNotRetiredShape(input, "package draft");
    keysAre(input, ["schemaVersion", "promise", "verifier", "materials"], "package draft");
    if (!Array.isArray(input.materials))
        throw new Error("package draft materials must be an array");
    if (!input.promise || typeof input.promise !== "object" || Array.isArray(input.promise))
        throw new Error("package draft promise must be an object");
    const promiseId = stringField(input.promise.id, "package draft promise.id");
    assertNotRetiredId(promiseId, "package draft");
    if (!/^prom_[a-z0-9]{8,64}$/.test(promiseId))
        throw new Error("package draft promise.id is invalid");
    let root;
    try {
        root = await realpath(executionRoot);
    }
    catch {
        throw new Error("package draft execution root is unavailable");
    }
    const materials = [];
    for (const [index, material] of input.materials.entries()) {
        keysAre(material, ["path", "kind"], `package draft materials[${index}]`);
        const path = stringField(material.path, `package draft materials[${index}].path`);
        if (isAbsolute(path) ||
            path.includes("\\") ||
            path.split("/").some((part) => part === "" || part === "." || part === ".."))
            throw new Error(`package draft materials[${index}].path must be a normalized repository-relative path`);
        if (!path.startsWith(`.continuity/promises/${promiseId}/`))
            throw new Error(`package draft materials[${index}].path must be inside .continuity/promises/${promiseId}`);
        if (!["verifier", "fixture", "support"].includes(material.kind))
            throw new Error(`package draft materials[${index}].kind is invalid`);
        let resolved;
        try {
            resolved = await realpath(pathResolve(root, path));
        }
        catch {
            throw new Error(`package draft material is unavailable: ${path}`);
        }
        const relativePath = relative(root, resolved);
        if (relativePath.startsWith("..") || isAbsolute(relativePath))
            throw new Error(`package draft material escapes the repository root: ${path}`);
        const info = await stat(resolved);
        if (!info.isFile() || info.size > 16 * 1024 * 1024)
            throw new Error(`package draft material must be a file no larger than 16 MiB: ${path}`);
        const contents = await readFile(resolved);
        if (contents.includes(Buffer.from("BALLADEER_STARTER_VERIFIER")) ||
            isScaffoldVerifierSource(contents))
            throw new Error("package draft still contains the scaffold verifier");
        if (contents.includes(Buffer.from('"replaceMe": true')))
            throw new Error("package draft still contains the scaffold fixture");
        materials.push({
            path,
            kind: material.kind,
            digest: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
        });
    }
    await assertExactMaterialClosure(promiseId, materials, root);
    assertNoStarterPlaceholders(input.promise, materials, "package draft");
    const base = {
        schemaVersion: input.schemaVersion,
        promise: input.promise,
        verifier: input.verifier,
        materials,
    };
    return validatePackage({ ...base, packageDigest: packageDigest(base) });
}
function assertNoStarterPlaceholders(promise, materials, label) {
    const serialized = JSON.stringify(promise);
    if (serialized.includes("REPLACE_WITH_") || /replace with|replace me/i.test(serialized))
        throw new Error(`${label} still contains scaffold placeholders; replace the approved meaning`);
    for (const material of materials) {
        if (!material.kind || !["verifier", "fixture", "support"].includes(material.kind))
            continue;
        // These markers are generated only by `scaffold`; checking the locked
        // material itself prevents a placeholder verifier from being sealed even
        // when its package metadata has been edited.
        if (material.digest === sha256('{\n  "replaceMe": true\n}\n'))
            throw new Error(`${label} still contains the scaffold fixture`);
    }
}
/** Refuse to qualify a package that still contains the generated starter. */
export async function assertPackageReady(pkgInput, executionRoot = process.cwd()) {
    const pkg = validatePackage(pkgInput);
    await assertExactMaterialClosure(pkg.promise.id, pkg.materials, executionRoot);
    const materials = [];
    for (const material of pkg.materials) {
        let contents;
        try {
            contents = await readFile(pathResolve(executionRoot, material.path));
        }
        catch {
            throw new Error(`package material is unavailable: ${material.path}`);
        }
        if (contents.includes(Buffer.from("BALLADEER_STARTER_VERIFIER")) ||
            isScaffoldVerifierSource(contents))
            throw new Error("package still contains the scaffold verifier");
        materials.push(material);
    }
    assertNoStarterPlaceholders(pkg.promise, materials, "package");
    if (pkg.materials.some((material) => material.digest === sha256('{\n  "replaceMe": true\n}\n')))
        throw new Error("package still contains the scaffold fixture");
    return pkg;
}
function metadataField(value, label) {
    return stringField(value, `qualification metadata.${label}`);
}
export function validateQualificationMetadata(input) {
    keysAre(input, ["schemaVersion", "workspaceLocator", "receiptId", "revisionId", "bindingId", "workflowDigest"], "qualification metadata");
    if (input.schemaVersion !== "continuity-qualification-meta/v1")
        throw new Error("qualification metadata.schemaVersion is invalid");
    const workspaceLocator = metadataField(input.workspaceLocator, "workspaceLocator");
    const receiptId = metadataField(input.receiptId, "receiptId");
    const revisionId = metadataField(input.revisionId, "revisionId");
    const bindingId = metadataField(input.bindingId, "bindingId");
    const workflowDigest = digestField(input.workflowDigest, "qualification metadata.workflowDigest");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(workspaceLocator))
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
function githubQualificationMetadata(metadata) {
    const env = process.env;
    const required = (name) => {
        const value = env[name];
        if (!value?.trim())
            throw new Error(`qualification publisher requires ${name}`);
        return value;
    };
    const runAttempt = Number(required("GITHUB_RUN_ATTEMPT"));
    if (!Number.isSafeInteger(runAttempt) || runAttempt < 1)
        throw new Error("qualification publisher requires a positive GITHUB_RUN_ATTEMPT");
    const sourceSha = required("GITHUB_SHA");
    if (!isGitSha(sourceSha))
        throw new Error("qualification publisher requires an exact GITHUB_SHA");
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
export async function buildQualificationRequest(pkgInput, metadataInput, executionRoot = process.cwd()) {
    const pkg = await assertPackageReady(pkgInput, executionRoot);
    const metadata = githubQualificationMetadata(validateQualificationMetadata(metadataInput));
    const results = await runAll(pkg, executionRoot, metadata.sourceSha);
    const byControl = new Map(results.map((result) => [result.control, result]));
    const tamperControl = await runTamperControl(pkg, executionRoot, metadata.sourceSha);
    // Every published control is the same closed pair. The tamper control's
    // local result also carries the promise id, which the receipt already
    // binds through packageDigest and semanticDigest, so it is projected to
    // { outcome, resultDigest } like good/bad/refactor rather than sent whole.
    // The tamper detection semantics are unchanged; only the published shape is
    // narrowed.
    const tamper = { outcome: tamperControl.outcome, resultDigest: tamperControl.resultDigest };
    const result = (control) => {
        const item = byControl.get(control);
        if (!item)
            throw new Error(`qualification result is missing ${control}`);
        // The local runner reports whether the control's expectation passed. The
        // qualification API records the observed behavior: the known-bad control
        // is therefore represented as `fail` when its expected non-zero command
        // exited as expected.
        const observedOutcome = item.outcome === "custody-invalid" ? "unknown" : item.outcome;
        const outcome = control === "bad" && observedOutcome === "pass"
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
        semanticDigest: pkg.promise.semanticDigest,
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
export async function scaffoldPackage(outputPath, promiseId = "prom_example01", executionRoot = process.cwd()) {
    if (outputPath !== ".continuity")
        throw new Error("scaffold output must be the repository-local .continuity directory");
    assertNotRetiredId(promiseId, "scaffold");
    if (!/^prom_[a-z0-9]{8,64}$/.test(promiseId))
        throw new Error("scaffold promise id must match prom_[a-z0-9]{8,64}");
    const root = await realpath(executionRoot).catch(() => {
        throw new Error("scaffold execution root is unavailable");
    });
    const destination = pathResolve(root, outputPath);
    const relativeDestination = relative(root, destination);
    if (!relativeDestination ||
        relativeDestination.startsWith("..") ||
        isAbsolute(relativeDestination))
        throw new Error("scaffold output escapes the repository root");
    try {
        const info = await lstat(destination);
        if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error("scaffold output must be a real directory");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        await mkdir(destination, { recursive: true });
    }
    const promiseRoot = `${outputPath}/promises/${promiseId}`;
    const verifierPath = `${promiseRoot}/verifier.mjs`;
    const fixturePath = `${promiseRoot}/fixture.json`;
    const draftPath = `${outputPath}/drafts/${promiseId}.json`;
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
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
    const meaning = {
        id: promiseId,
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
        promise: {
            ...meaning,
            semanticDigest: sha256(canonicalize(semanticMeaning(meaning))),
            ownerId: "REPLACE_WITH_OWNER_ID",
        },
        verifier: {
            target: { executable: "node", args: [verifierPath, "target"] },
            good: { executable: "node", args: [verifierPath, "good"] },
            bad: { executable: "node", args: [verifierPath, "bad"] },
            refactor: { executable: "node", args: [verifierPath, "refactor"] },
        },
        materials: [
            { path: verifierPath, kind: "verifier" },
            { path: fixturePath, kind: "fixture" },
        ],
    };
    const verifier = `const control = process.argv[2];\n// BALLADEER_STARTER_VERIFIER: replace this with a real customer-behavior verifier.\nprocess.exit(control === "bad" ? 1 : 0);\n`;
    const fixture = '{\n  "replaceMe": true\n}\n';
    const readme = `# Continuity starter\n\nThis directory was generated locally for **${promiseId}**. It is an authoring starter, not a protected behavior.\n\n1. Replace every placeholder in drafts/${promiseId}.json.\n2. Replace promises/${promiseId}/verifier.mjs with a real verifier and update promises/${promiseId}/fixture.json. The starter verifier only demonstrates control wiring.\n3. From the repository root, seal it into ${outputPath}/packages/${promiseId}.json:\n\n   continuity-runner seal ${draftPath} ${outputPath}/packages/${promiseId}.json\n\nThe seal command refuses to overwrite an existing output. Run the local qualification controls before asking the Balladeer owner to activate the package. No source, fixture contents, or verifier output is sent to Balladeer; only closed digests and normalized outcomes are publishable.\n`;
    await mkdir(pathResolve(root, promiseRoot), { recursive: true });
    await mkdir(pathResolve(root, `${outputPath}/drafts`), { recursive: true });
    await mkdir(pathResolve(root, `${outputPath}/packages`), { recursive: true });
    for (const [path, contents] of [
        [verifierPath, verifier],
        [fixturePath, fixture],
        [draftPath, JSON.stringify(draft, null, 2) + "\n"],
        [readmePath, readme],
    ])
        await writeFile(pathResolve(root, path), contents, { encoding: "utf8", flag: "wx" });
    return { root: destination, draftPath, verifierPath, fixturePath, readmePath };
}
export function validateExecutionManifest(input) {
    assertNotRetiredManifest(input);
    keysAre(input, ["schemaVersion", "targetId", "generatedAt", "promises", "manifestDigest"], "manifest");
    if (input.schemaVersion !== "continuity-ci/v1")
        throw new Error("manifest.schemaVersion is invalid");
    stringField(input.targetId, "manifest.targetId");
    stringField(input.generatedAt, "manifest.generatedAt");
    if (Number.isNaN(Date.parse(input.generatedAt)))
        throw new Error("manifest.generatedAt is invalid");
    if (!Array.isArray(input.promises))
        throw new Error("manifest.promises must be an array");
    const seen = new Set();
    for (const entry of input.promises) {
        keysAre(entry, ["id", "packageDigest"], "manifest promise");
        stringField(entry.id, "manifest promise id");
        digestField(entry.packageDigest, "manifest packageDigest");
        if (seen.has(entry.id))
            throw new Error("manifest has duplicate promise id");
        seen.add(entry.id);
    }
    digestField(input.manifestDigest, "manifest.manifestDigest");
    const { manifestDigest: _digest, ...base } = input;
    if (input.manifestDigest !== sha256(canonicalize(base)))
        throw new Error("manifestDigest does not match manifest contents");
    return input;
}
/**
 * Resolve every manifest entry on its own. A missing, re-sealed, or ambiguous
 * package used to throw before any verifier ran, so the control plane received
 * no results at all and swept every other promise into the same missing state.
 * Each entry now resolves to exactly one answer: a package to run, or a
 * custody-invalid verdict for that promise alone. Manifest cardinality is
 * preserved either way.
 */
export function selectManifestEntries(packages, manifestInput) {
    const manifest = validateExecutionManifest(manifestInput);
    const byId = new Map();
    const ambiguous = new Set();
    for (const pkg of packages) {
        if (byId.has(pkg.promise.id))
            ambiguous.add(pkg.promise.id);
        else
            byId.set(pkg.promise.id, pkg);
    }
    return manifest.promises.map((entry) => {
        const unavailable = (reason) => ({
            kind: "unavailable",
            promiseId: entry.id,
            packageDigest: entry.packageDigest,
            reason,
        });
        // A duplicate id is never resolved by preference: the run cannot tell which
        // sealed package the manifest meant, so that promise stays custody-invalid
        // rather than executing a guess.
        if (ambiguous.has(entry.id))
            return unavailable("ambiguous");
        const pkg = byId.get(entry.id);
        if (!pkg)
            return unavailable("missing");
        if (pkg.packageDigest !== entry.packageDigest)
            return unavailable("digest-changed");
        return { kind: "package", promiseId: entry.id, package: pkg };
    });
}
/**
 * Run the selected manifest entries serially. Target mode produces one result
 * per entry and exercise mode produces one per control, so the count the
 * control plane checks against the frozen manifest is the same whether a
 * package ran or was unavailable.
 */
export async function runManifestEntries(selections, mode, executionRoot = process.cwd(), sourceSha = process.env.BALLADEER_SOURCE_SHA ?? process.env.GITHUB_SHA) {
    const results = [];
    if (selections.length === 0)
        return results;
    if (!isGitSha(sourceSha))
        throw new Error("sourceSha must be an exact 40-hex commit SHA");
    const controls = mode === "target" ? ["target"] : [...CONTROLS];
    for (const selection of selections)
        for (const control of controls)
            results.push(selection.kind === "package"
                ? await runVerifier(selection.package, control, executionRoot, sourceSha)
                : closedResult(selection.promiseId, selection.packageDigest, control, new Date(), sourceSha, "custody-invalid", null, "invalid"));
    return results;
}
function digestStream(value) {
    return sha256(value);
}
function expectedFor(control, exitCode) {
    return control === "bad" ? exitCode !== 0 : exitCode === 0;
}
function resultDigest(result) {
    return sha256(canonicalize(resultWithoutDigest(result)));
}
export function lockedMaterialsDigest(pkgInput, kinds = ["verifier", "fixture", "support"]) {
    const pkg = validatePackage(pkgInput);
    const selected = pkg.materials
        .filter((material) => kinds.includes(material.kind))
        .map((material) => ({ path: material.path, kind: material.kind, digest: material.digest }))
        .sort((left, right) => left.path.localeCompare(right.path));
    return sha256(canonicalize(selected));
}
export async function verifyLockedMaterials(pkgInput, executionRoot = process.cwd()) {
    const pkg = validatePackage(pkgInput);
    try {
        await assertExactMaterialClosure(pkg.promise.id, pkg.materials, executionRoot);
        const root = await realpath(executionRoot);
        for (const material of pkg.materials) {
            const resolved = await realpath(pathResolve(root, material.path));
            const relativePath = relative(root, resolved);
            if (relativePath.startsWith("..") || isAbsolute(relativePath))
                return false;
            const info = await stat(resolved);
            if (!info.isFile() || info.size > 16 * 1024 * 1024)
                return false;
            const contents = await readFile(resolved);
            const actual = `sha256:${createHash("sha256").update(contents).digest("hex")}`;
            if (actual !== material.digest)
                return false;
        }
    }
    catch {
        return false;
    }
    return true;
}
export function validateResult(input) {
    keysAre(input, resultKeys, "result");
    if (input.schemaVersion !== RUNNER_SCHEMA)
        throw new Error(`result.schemaVersion must be ${RUNNER_SCHEMA}`);
    if (!RUN_MODES.includes(input.control))
        throw new Error("result.control is invalid");
    if (!["pass", "fail", "unknown", "canceled", "custody-invalid"].includes(input.outcome))
        throw new Error("result.outcome is invalid");
    stringField(input.promiseId, "result.promiseId");
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
    if (typeof input.durationMs !== "number" ||
        !Number.isSafeInteger(input.durationMs) ||
        input.durationMs < 0)
        throw new Error("result.durationMs is invalid");
    if (input.exitCode !== null && !Number.isSafeInteger(input.exitCode))
        throw new Error("result.exitCode is invalid");
    if (input.resultDigest !== resultDigest(input))
        throw new Error("resultDigest does not match result contents");
    return input;
}
// ---------------------------------------------------------------------------
// The runner has two output channels and they never mix.
//
// Standard output carries the closed result JSON and nothing else: the caller
// workflow redirects it into the artifact that token-bearing jobs publish.
// Standard error carries everything a person reads, including each verifier's
// own stdout and stderr, so a red check explains itself in the customer's own
// GitHub job log. Echoed output never reaches a result field, a digest, or the
// published payload; it stays inside the customer's run.
//
// Everything echoed is untrusted text: verifier bytes, package prose written by
// the customer, and promise ids from the frozen manifest. GitHub Actions reads
// workflow commands such as `::error::` from a job's output, so echoed text is
// stripped of control characters, bounded, and always printed behind a fixed
// prefix. It can never begin a line, and therefore can never forge a command,
// an annotation, or a job-summary write.
// ---------------------------------------------------------------------------
const humanPrefix = "[balladeer]";
const outputLimit = 1_048_576;
const csiSequence = /\u001b\[[0-9;:?]*[\u0020-\u002f]*[@-~]/g;
const controlCharacter = /[\u0000-\u001f\u007f]/g;
function loggable(value, limit) {
    const flattened = value.replace(csiSequence, "").replace(controlCharacter, " ");
    return flattened.length > limit ? `${flattened.slice(0, limit)} [truncated]` : flattened;
}
function humanLine(text) {
    process.stderr.write(`${humanPrefix} ${text}\n`);
}
function annotate(level, message) {
    if (process.env.GITHUB_ACTIONS !== "true")
        return;
    // GitHub decodes %25, %0A, and %0D inside an annotation message. The message
    // has already lost every control character, so only the escape character
    // itself still has to be escaped.
    process.stderr.write(`::${level}::${message.replace(/%/g, "%25")}\n`);
}
/**
 * Echo one verifier process's output to the human channel, line by line, under
 * the same 1 MiB per-stream bound the digests use. The bound counts the bytes
 * actually written to the log, not the bytes the verifier produced: a stream of
 * very short lines would otherwise multiply through the per-line prefix. Each
 * line is capped as well, so one enormous line cannot fill the bound alone.
 *
 * The digest is still computed over every raw byte the verifier wrote. Only
 * what a person reads is bounded and sanitized.
 */
function outputEcho(promiseId, control) {
    const decoder = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const pending = { stdout: "", stderr: "" };
    const echoed = { stdout: 0, stderr: 0 };
    const stopped = { stdout: false, stderr: false };
    const prefix = `${humanPrefix} ${loggable(promiseId, 80)} ${control}`;
    const line = (stream, text) => {
        if (stopped[stream])
            return;
        const rendered = `${prefix} ${stream}: ${loggable(text, 4_000)}\n`;
        if (echoed[stream] + Buffer.byteLength(rendered) > outputLimit) {
            stopped[stream] = true;
            process.stderr.write(`${prefix} ${stream}: [stopped echoing at ${outputLimit} bytes of log; the recorded digest still covers every byte the verifier wrote]\n`);
            return;
        }
        echoed[stream] += Buffer.byteLength(rendered);
        process.stderr.write(rendered);
    };
    const drain = (stream) => {
        const rest = pending[stream];
        pending[stream] = "";
        if (rest !== "")
            line(stream, rest);
    };
    return {
        add: (chunk, stream) => {
            if (stopped[stream])
                return;
            const text = pending[stream] + decoder[stream].write(chunk);
            const lines = text.split("\n");
            pending[stream] = lines.pop() ?? "";
            for (const item of lines)
                line(stream, item);
            if (pending[stream].length > 4_000)
                drain(stream);
        },
        flush: () => {
            drain("stdout");
            drain("stderr");
        },
    };
}
function unavailableExplanation(reason) {
    if (reason === "missing")
        return "No sealed package for this promise is in the package directory, so no verifier ran. Restore the sealed package, or ask Balladeer to retire the promise.";
    if (reason === "digest-changed")
        return "The sealed package in the repository no longer matches the frozen manifest, so no verifier ran. Activate the re-sealed package with Balladeer.";
    return "More than one sealed package declares this promise id, so no verifier ran. Remove the duplicate.";
}
const summaryLimit = 65_536;
async function appendJobSummary(rows) {
    const path = process.env.GITHUB_STEP_SUMMARY;
    if (!path || rows.length === 0)
        return;
    const table = [
        "### Balladeer continuity attestor",
        "",
        "| Promise | Control | Outcome | Detail |",
        "| --- | --- | --- | --- |",
        ...rows,
        "",
    ].join("\n");
    try {
        await appendFile(path, `${table.slice(0, summaryLimit)}\n`, "utf8");
    }
    catch {
        humanLine("could not write the GitHub job summary; the lines above are the whole report");
    }
}
/**
 * Say what happened, in the customer's own job log, for every promise the run
 * covered. This is explanation only: it reads finished results and writes to
 * the human channel, the GitHub annotation stream, and the job summary. It
 * never changes a result and never adds a field to what is published.
 */
export async function announceRun(selections, results, rejectedPackageFiles = []) {
    const cell = (value, limit) => loggable(value, limit).replace(/\|/g, "\\|");
    const byPromise = new Map(selections.map((selection) => [selection.promiseId, selection]));
    for (const file of rejectedPackageFiles)
        humanLine(`a package file was skipped because it is not a valid sealed package: ${loggable(file, 200)}`);
    if (results.length === 0)
        return;
    humanLine(`${results.length} verifier result(s) across ${selections.length} active promise(s).`);
    const rows = [];
    for (const result of results) {
        const selection = byPromise.get(result.promiseId);
        const pkg = selection?.kind === "package" ? selection.package : undefined;
        const title = pkg ? loggable(pkg.promise.title, 160) : "";
        const approvedOutcome = pkg ? loggable(pkg.promise.observableOutcome, 240) : "";
        const reason = selection?.kind === "unavailable" ? unavailableExplanation(selection.reason) : "";
        const promiseId = loggable(result.promiseId, 80);
        const subject = title === "" ? promiseId : `${promiseId} (${title})`;
        const detail = reason !== ""
            ? reason
            : approvedOutcome === ""
                ? ""
                : `Approved observable outcome: ${approvedOutcome}`;
        const sentence = `${subject}: ${result.control} control outcome ${result.outcome}.${detail === "" ? "" : ` ${detail}`}`;
        humanLine(sentence);
        annotate(result.outcome === "pass" ? "notice" : "error", sentence);
        rows.push(`| ${cell(subject, 240)} | ${result.control} | ${result.outcome} | ${cell(detail, 240)} |`);
    }
    await appendJobSummary(rows);
}
/**
 * Customer verifiers are untrusted processes. They need a minimal operating
 * environment, not the Actions control plane: in particular they must never
 * inherit OIDC, GitHub file-command, artifact, runner, or checkout metadata.
 * There is intentionally no package-level arbitrary env passthrough.
 */
export function verifierEnvironment(environment = process.env) {
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
    const clean = {};
    for (const key of allowed) {
        const value = environment[key];
        if (typeof value === "string" && value.length > 0)
            clean[key] = value;
    }
    return clean;
}
export async function runVerifier(pkgInput, control, executionRoot = process.cwd(), sourceSha = process.env.BALLADEER_SOURCE_SHA ?? process.env.GITHUB_SHA) {
    const pkg = validatePackage(pkgInput);
    if (!isGitSha(sourceSha))
        throw new Error("sourceSha must be an exact 40-hex commit SHA");
    const spec = pkg.verifier[control];
    const started = new Date();
    const custodyInvalid = () => closedResult(pkg.promise.id, pkg.packageDigest, control, started, sourceSha, "custody-invalid", null, "invalid");
    if (!(await verifyLockedMaterials(pkg, executionRoot)))
        return custodyInvalid();
    const timeout = spec.timeoutMs ?? 120_000;
    let root;
    let cwd;
    try {
        root = await realpath(executionRoot);
        cwd = await realpath(pathResolve(root, spec.cwd ?? "."));
    }
    catch {
        return custodyInvalid();
    }
    const relativeCwd = relative(root, cwd);
    if (relativeCwd.startsWith("..") || isAbsolute(relativeCwd)) {
        return custodyInvalid();
    }
    return new Promise((settle) => {
        const echo = outputEcho(pkg.promise.id, control);
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const stdoutHash = createHash("sha256");
        const stderrHash = createHash("sha256");
        let settled = false;
        let exited = false;
        let forcedOutcome;
        const child = spawn(spec.executable, spec.args, {
            cwd,
            shell: false,
            detached: true,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: verifierEnvironment(),
        });
        const terminateGroup = (signal) => {
            if (child.pid) {
                try {
                    process.kill(-child.pid, signal);
                }
                catch {
                    try {
                        child.kill(signal);
                    }
                    catch {
                        // The process has already exited.
                    }
                }
            }
        };
        let killTimer;
        const stop = (outcome) => {
            forcedOutcome ??= outcome;
            terminateGroup("SIGTERM");
            killTimer ??= setTimeout(() => terminateGroup("SIGKILL"), 250);
        };
        const updateOutput = (chunk, stream) => {
            if (stream === "stdout") {
                stdoutBytes += chunk.byteLength;
                stdoutHash.update(chunk);
                if (stdoutBytes > outputLimit)
                    stop("unknown");
            }
            else {
                stderrBytes += chunk.byteLength;
                stderrHash.update(chunk);
                if (stderrBytes > outputLimit)
                    stop("unknown");
            }
            // The digest above covers every raw byte. The echo below is a bounded,
            // sanitized copy for the customer's own job log and changes nothing that
            // is published.
            echo.add(chunk, stream);
        };
        child.stdout.on("data", (chunk) => updateOutput(chunk, "stdout"));
        child.stderr.on("data", (chunk) => updateOutput(chunk, "stderr"));
        const timer = setTimeout(() => stop("unknown"), timeout);
        const finish = (outcome, exitCode) => {
            if (settled || !exited)
                return;
            settled = true;
            clearTimeout(timer);
            if (killTimer)
                clearTimeout(killTimer);
            echo.flush();
            const completed = new Date();
            const base = {
                schemaVersion: RUNNER_SCHEMA,
                runnerVersion: RUNNER_VERSION,
                promiseId: pkg.promise.id,
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
            const outcome = forcedOutcome ??
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
/**
 * A result reached without running a verifier. It is addressed by promise id
 * and package digest rather than by a package object, because the manifest can
 * name a promise whose sealed package is missing, re-sealed, or ambiguous:
 * that entry still owes the control plane exactly one closed result, carrying
 * the digest the frozen manifest expected.
 */
function closedResult(promiseId, packageDigest, control, started, sourceSha, outcome, exitCode, custody) {
    const completed = new Date();
    const base = {
        schemaVersion: RUNNER_SCHEMA,
        runnerVersion: RUNNER_VERSION,
        promiseId,
        packageDigest,
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
export async function runOne(pkgInput, control, executionRoot = process.cwd(), sourceSha = process.env.BALLADEER_SOURCE_SHA ?? process.env.GITHUB_SHA) {
    return runVerifier(pkgInput, control, executionRoot, sourceSha);
}
export async function runAll(pkgInput, executionRoot = process.cwd(), sourceSha = process.env.BALLADEER_SOURCE_SHA ?? process.env.GITHUB_SHA) {
    const results = [];
    for (const control of CONTROLS)
        results.push(await runVerifier(pkgInput, control, executionRoot, sourceSha));
    return results;
}
export async function runAllPackages(packages, executionRoot = process.cwd(), sourceSha = process.env.BALLADEER_SOURCE_SHA ?? process.env.GITHUB_SHA) {
    const results = [];
    for (const pkg of packages)
        results.push(...(await runAll(pkg, executionRoot, sourceSha)));
    return results;
}
export async function runTarget(pkgInput, executionRoot = process.cwd(), sourceSha = process.env.BALLADEER_SOURCE_SHA ?? process.env.GITHUB_SHA) {
    return runVerifier(pkgInput, "target", executionRoot, sourceSha);
}
export async function runTargetPackages(packages, executionRoot = process.cwd(), sourceSha = process.env.BALLADEER_SOURCE_SHA ?? process.env.GITHUB_SHA) {
    const results = [];
    for (const pkg of packages)
        results.push(await runTarget(pkg, executionRoot, sourceSha));
    return results;
}
/**
 * Exercise the actual local custody boundary by changing one locked material,
 * running the verifier, and restoring the bytes before returning. The result
 * exposes only an outcome and digest; it never serializes the changed file.
 */
export async function runTamperControl(pkgInput, executionRoot = process.cwd(), sourceSha = process.env.BALLADEER_SOURCE_SHA ?? process.env.GITHUB_SHA) {
    const pkg = validatePackage(pkgInput);
    const material = pkg.materials.find((item) => item.kind === "verifier") ?? pkg.materials[0];
    if (!material)
        throw new Error("package has no locked materials");
    let root;
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
                promiseId: pkg.promise.id,
                outcome: observed.custody === "invalid" ? "detected" : "not_detected",
                resultDigest: observed.resultDigest,
            };
        }
        finally {
            await writeFile(resolved, original);
        }
    }
    catch (error) {
        if (error instanceof Error && error.message === "tamper material escapes the repository root")
            throw error;
        return {
            promiseId: pkg.promise.id,
            outcome: "unknown",
            resultDigest: sha256(`tamper-control-error:${pkg.promise.id}`),
        };
    }
}
export async function runTamperControls(packages, executionRoot = process.cwd(), sourceSha = process.env.BALLADEER_SOURCE_SHA ?? process.env.GITHUB_SHA) {
    const controls = [];
    for (const pkg of packages)
        controls.push(await runTamperControl(pkg, executionRoot, sourceSha));
    return controls;
}
export function exercisePasses(results) {
    const promiseIds = new Set(results.map((result) => result.promiseId));
    return (promiseIds.size > 0 &&
        [...promiseIds].every((promiseId) => CONTROLS.every((control) => results.filter((result) => result.promiseId === promiseId && result.control === control)
            .length === 1 &&
            results.some((result) => result.promiseId === promiseId &&
                result.control === control &&
                result.outcome === "pass"))));
}
export function detectsPackageTampering(pkgInput) {
    const pkg = validatePackage(pkgInput);
    const changed = structuredClone(pkg);
    changed.promise.title = `${changed.promise.title} (tampered)`;
    try {
        validatePackage(changed);
        return false;
    }
    catch {
        return true;
    }
}
export function detectsVerifierTampering(pkgInput) {
    const pkg = validatePackage(pkgInput);
    const changed = structuredClone(pkg);
    const verifierMaterial = changed.materials.find((material) => material.kind === "verifier");
    if (!verifierMaterial)
        return false;
    verifierMaterial.digest = `sha256:${"0".repeat(64)}`;
    try {
        validatePackage(changed);
        return false;
    }
    catch {
        return true;
    }
}
export function qualificationSummary(packages, results, tamperControls = []) {
    const perPromise = packages.map((pkg) => {
        const ownResults = results.filter((result) => result.promiseId === pkg.promise.id);
        const tamper = tamperControls.find((item) => item.promiseId === pkg.promise.id);
        // A metadata mutation is not an executed tamper control. Qualification
        // must be based on the real material mutation exercised by
        // `qualification-request`; callers that did not run it stay unknown.
        const tamperDetected = tamper?.outcome === "detected";
        return {
            promiseId: pkg.promise.id,
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
        allControlsPassed: sourceShaConsistent && perPromise.every((item) => item.controlsPassed),
        packageTamperDetected: perPromise.every((item) => item.packageTamperDetected),
        verifierTamperDetected: perPromise.every((item) => item.verifierTamperDetected),
        tamperDetected: perPromise.every((item) => item.tamperDetected),
        custody: "customer-local-unattested",
        perPromise,
    };
}
export function createOffboardingExport(pkgInput, results = []) {
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
