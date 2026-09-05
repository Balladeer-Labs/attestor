import { createHash, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readdir, readFile, realpath, stat, unlink, writeFile, } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve as pathResolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
// The sealed package and the published result are versioned separately on
// purpose. A package sealed before the verifier result protocol existed is
// still a valid package, and its digest is unchanged, so bumping the result
// schema must never invalidate a customer's sealed material or make every
// promise report a changed digest.
export const RUNNER_SCHEMA = "continuity-package/v1";
export const RESULT_SCHEMA = "continuity-result/v2";
export const RUNNER_VERSION = "0.1.0";
export const CONTROLS = ["good", "bad", "refactor"];
export const RUN_MODES = ["target", ...CONTROLS];
/**
 * The closed outcome vocabulary. `fail` is retired from the wire: it meant
 * "did not meet expectation", which is exactly the conflation this protocol
 * removes. A crash is never a pass and is never a refutation.
 */
export const RUN_OUTCOMES = [
    "pass",
    "refuted",
    "errored",
    "timed_out",
    "canceled",
    "custody-invalid",
];
/** Why a non-pass, non-refuted outcome could not be a verdict. */
export const OUTCOME_REASONS = [
    "spawn_failed",
    "nonzero_exit",
    "signal_killed",
    "timeout",
    "output_limit",
    "result_missing",
    "result_unparseable",
    "result_too_large",
    "result_disagrees_exit",
    "verifier_reported_error",
    "no_examples_ran",
    "protocol_undeclared",
    "canceled_external",
    "custody_failed",
    /**
     * The verification job that owned this promise never reported. Verification
     * is fanned out across shards, and a shard can die for reasons that have
     * nothing to do with the customer's code: the runner was lost, the job hit
     * its own wall clock, GitHub cancelled it, the artifact upload failed.
     *
     * It is minted by the merge, never by a verifier, and it says exactly one
     * thing: nothing ran for this promise, so nothing is known about it. It is an
     * infrastructure failure of Balladeer's own fan-out and can only ever produce
     * Unknown. It is never a refutation, and it never reaches a promise outside
     * the dead shard's own slice.
     */
    "shard_failed",
];
/**
 * Signal names are OS-supplied strings, so they are mapped onto a closed list
 * before they can reach a published field. Anything else is `other`.
 *
 * The list names every signal a person would want to tell apart when reading
 * why a verifier died, and the resource-limit signals earn their place: a
 * container that hits its CPU budget is killed with `SIGXCPU`, one that hits a
 * file-size limit with `SIGXFSZ`, and a debugger trap or a failed assertion
 * compiled into a native dependency arrives as `SIGTRAP`. Collapsed into
 * `other` those three are indistinguishable from an unknown signal, and the
 * repair for each is different: raise the budget, raise the limit, fix the
 * dependency. All three are `errored` / `signal_killed` either way, so naming
 * them changes only what the reason line can say, never the verdict.
 *
 * This is the same closed list the control plane's intake accepts, which is a
 * superset by construction: the intake keeps every name this list carries, so a
 * result from an older runner that only ever reported the shorter list still
 * parses unchanged.
 */
export const RESULT_SIGNALS = [
    "SIGABRT",
    "SIGBUS",
    "SIGFPE",
    "SIGHUP",
    "SIGILL",
    "SIGINT",
    "SIGKILL",
    "SIGPIPE",
    "SIGQUIT",
    "SIGSEGV",
    "SIGTERM",
    "SIGTRAP",
    "SIGXCPU",
    "SIGXFSZ",
    "other",
];
/** The largest example count a published result may carry. */
const exampleCountLimit = 1_000_000;
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
const packageKeys = [
    "schemaVersion",
    "promise",
    "verifier",
    "results",
    "attribution",
    "materials",
    "packageDigest",
];
const draftKeys = ["schemaVersion", "promise", "verifier", "results", "attribution", "materials"];
// Exactly what a published result may carry. Every entry is an enum, an
// integer, an identifier, a timestamp, or a SHA-256 digest: no path, no
// message, no example name, no free text.
const resultKeys = [
    "schemaVersion",
    "runnerVersion",
    "promiseId",
    "packageDigest",
    "sourceSha",
    "control",
    "outcome",
    "outcomeReason",
    "exitCode",
    "signal",
    "durationMs",
    "stdoutDigest",
    "stderrDigest",
    "resultProtocol",
    "resultDocumentDigest",
    "exampleTotal",
    "exampleRefuted",
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
/** What the scaffold writes when the four facts were not supplied. Every one of
 * these is refused by `seal`, so a starter can never be sealed with them. */
export const SCAFFOLD_FACT_PLACEHOLDERS = {
    claim: "REPLACE_WITH_THE_OWNER_APPROVED_OBSERVABLE_OUTCOME",
    owner: "REPLACE_WITH_THE_OWNER_NAME",
    promiseUrl: "https://REPLACE_WITH_THE_BALLADEER_PROMISE_PAGE",
};
/**
 * The generated starter verifier, with this promise's own four facts in it.
 *
 * Two things are deliberate. The facts are printed on stderr, not stdout, so a
 * verifier declaring the native protocol still writes only its result document
 * where the runner reads it. And they are printed only when the behavior is
 * refuted: a passing run that shouted four facts at every invocation would be
 * noise a customer edits out, and then the red says nothing.
 */
function scaffoldVerifierProgram(promiseId, facts) {
    const literal = (value) => JSON.stringify(value);
    return `import { writeFileSync } from "node:fs";
const BALLADEER_PROMISE_ID = ${literal(promiseId)};
const BALLADEER_PROMISE_CLAIM = ${literal(facts.claim)};
const BALLADEER_PROMISE_OWNER = ${literal(facts.owner)};
const BALLADEER_PROMISE_URL = ${literal(facts.promiseUrl)};
const control = process.argv[2];
// BALLADEER_STARTER_VERIFIER: replace this with a real customer-behavior verifier.
const refuted = control === "bad" ? 1 : 0;
if (refuted) {
  process.stderr.write("Balladeer promise " + BALLADEER_PROMISE_ID + " is refuted by this run.\\n");
  process.stderr.write("  Promise: " + BALLADEER_PROMISE_CLAIM + "\\n");
  process.stderr.write("  Owner: " + BALLADEER_PROMISE_OWNER + "\\n");
  process.stderr.write("  Promise page: " + BALLADEER_PROMISE_URL + "\\n");
}
writeFileSync(process.env.BALLADEER_RESULT_PATH, JSON.stringify({ schemaVersion: "continuity-verifier-result/v1", outcome: refuted ? "refuted" : "passed", examples: { total: 1, refuted, errored: 0 } }));
process.exit(refuted);
`;
}
// The scaffold's marker is deliberately not the only readiness guard. A
// customer can remove a comment without having authored a verifier. Keep a
// normalized structural fingerprint of the generated control program so that
// whitespace/comments (including the marker itself) cannot launder it.
//
// The starter also demonstrates the native result protocol, because that is
// the whole of it: write one small document at the path the runner exports,
// with no Balladeer dependency, no import beyond node:fs, and no network.
const scaffoldVerifierStructure = scaffoldVerifierProgram("prom_structure", SCAFFOLD_FACT_PLACEHOLDERS);
/**
 * Two starters differ in four string literals and nothing else, because each
 * one carries its own promise's facts. The fingerprint blanks exactly those
 * four declarations before hashing, so it still recognizes every starter as a
 * starter and still refuses one whose comments were stripped. It blanks the
 * named declarations only, never string literals in general: a real verifier
 * that happens to share the starter's shape must not be laundered into it.
 */
const factDeclaration = /^const (BALLADEER_PROMISE_ID|BALLADEER_PROMISE_CLAIM|BALLADEER_PROMISE_OWNER|BALLADEER_PROMISE_URL) = (?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*');$/gm;
const normalizedSource = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(factDeclaration, "const $1 = $$FACT$$;")
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
/**
 * Validate the optional result-protocol declaration. The JUnit path is the
 * only customer-chosen path the runner writes to, so it is constrained here
 * rather than at execution time: normalized and repository-relative, never
 * inside the digest-locked promise tree (a report written there would break
 * exact material closure for every later control), and actually named in the
 * command that is supposed to produce it, since `spawn` runs with no shell and
 * cannot expand `$BALLADEER_RESULT_PATH` inside an argument.
 */
function validateResultSpec(results, verifier, promiseId, label) {
    keysAre(results, ["protocol", "file"], `${label} results`, ["file"]);
    const protocol = stringField(results.protocol, `${label} results.protocol`);
    if (protocol !== "native" && protocol !== "junit")
        throw new Error(`${label} results.protocol must be native or junit`);
    if (protocol === "native") {
        if (results.file !== undefined)
            throw new Error(`${label} results.file is only used by the junit protocol; the runner chooses the native document path itself`);
        return { protocol };
    }
    const file = stringField(results.file, `${label} results.file`);
    if (isAbsolute(file) ||
        file.includes("\\") ||
        file.split("/").some((part) => part === "" || part === "." || part === ".."))
        throw new Error(`${label} results.file must be a normalized relative path`);
    if (file.startsWith(".continuity/promises/"))
        throw new Error(`${label} results.file must be outside .continuity/promises/${promiseId}, because a report written inside the promise tree breaks exact material closure`);
    for (const control of RUN_MODES) {
        const command = verifier[control];
        if (!command?.args.some((argument) => argument.includes(file)))
            throw new Error(`${label} verifier.${control} must name results.file in its arguments, because the runner spawns it without a shell`);
    }
    return { protocol, file };
}
/**
 * Validate the optional owner-and-page member.
 *
 * The URL is checked here rather than where it is printed, because it is
 * printed into three channels a customer reads: a terminal line, a GitHub
 * annotation, and a Markdown table. A scheme that is not `http` or `https`
 * cannot be opened and has no business in any of them, and userinfo in a URL is
 * a credential nobody should seal into a repository.
 */
function validateAttribution(input, label) {
    keysAre(input, ["owner", "promiseUrl"], label);
    const owner = stringField(input.owner, `${label}.owner`);
    if (owner.length > 160)
        throw new Error(`${label}.owner must be at most 160 characters`);
    const promiseUrl = stringField(input.promiseUrl, `${label}.promiseUrl`);
    if (promiseUrl.length > 2_000)
        throw new Error(`${label}.promiseUrl must be at most 2000 characters`);
    let parsed;
    try {
        parsed = new URL(promiseUrl);
    }
    catch {
        throw new Error(`${label}.promiseUrl must be an absolute http or https URL`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
        throw new Error(`${label}.promiseUrl must be an absolute http or https URL`);
    if (parsed.username !== "" || parsed.password !== "")
        throw new Error(`${label}.promiseUrl must not carry a username or password`);
    return { owner, promiseUrl };
}
export function validatePackage(input) {
    assertNotRetiredShape(input, "package");
    keysAre(input, packageKeys, "package", ["results", "attribution"]);
    if (input.attribution !== undefined)
        validateAttribution(input.attribution, "attribution");
    if (input.schemaVersion !== RUNNER_SCHEMA)
        throw new Error(`package.schemaVersion must be ${RUNNER_SCHEMA}`);
    // `refactorExamples` is optional in the approved meaning: nothing asks a
    // person for one any more, and a meaning recorded while it was required
    // still carries it. This widens what a package may omit and narrows nothing.
    // The refactor CONTROL below is a separate field and is unchanged.
    keysAre(input.promise, meaningKeys, "promise", ["refactorExamples"]);
    const promiseId = stringField(input.promise.id, "promise.id");
    for (const key of ["title", "beneficiary", "trigger", "observableOutcome", "ownerId"])
        stringField(input.promise[key], `promise.${key}`);
    assertNotRetiredId(promiseId, "package");
    if (!/^prom_[a-z0-9]{8,64}$/.test(promiseId))
        throw new Error("promise.id is invalid");
    digestField(input.promise.semanticDigest, "promise.semanticDigest");
    for (const key of ["preconditions", "allowedVariations", "nonGoals"])
        stringArray(input.promise[key], `promise.${key}`);
    for (const key of ["passingExamples", "failingExamples"])
        validateExamples(input.promise[key], `promise.${key}`);
    if (input.promise.refactorExamples !== undefined)
        validateExamples(input.promise.refactorExamples, "promise.refactorExamples");
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
    if (input.results !== undefined)
        validateResultSpec(input.results, input.verifier, promiseId, "package");
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
    // `attribution` is listed as optional to `keysAre` so that the sentence below
    // is the one a person reads. A bare "missing field: attribution" says what is
    // absent and nothing about what to put there or why it matters.
    keysAre(input, draftKeys, "package draft", ["results", "attribution"]);
    // Required here, and optional on read. A package sealed before this member
    // existed keeps running; every package sealed from now on can name its owner
    // and its page in the line a coder reads when the check goes red, and the
    // moment to find that out is at the desk, not in a failing job.
    if (input.attribution === undefined)
        throw new Error('package draft is missing attribution: add {"owner": "<the owner\'s name>", "promiseUrl": "<the promise page in Balladeer>"} so a failing check can name who to talk to and what was agreed');
    const attribution = validateAttribution(input.attribution, "package draft attribution");
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
    assertNoStarterPlaceholders({ promise: input.promise, attribution }, materials, "package draft");
    const base = {
        schemaVersion: input.schemaVersion,
        promise: input.promise,
        verifier: input.verifier,
        ...(input.results === undefined ? {} : { results: input.results }),
        attribution,
        materials,
    };
    return validatePackage({ ...base, packageDigest: packageDigest(base) });
}
function assertNoStarterPlaceholders(
// The approved meaning and the owner-and-page member together. Both come out
// of `scaffold` full of placeholders, and a package that named its owner
// "REPLACE_WITH_THE_OWNER_NAME" would put that string in a red check.
meaningAndAttribution, materials, label) {
    const serialized = JSON.stringify(meaningAndAttribution);
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
    assertNoStarterPlaceholders({
        promise: pkg.promise,
        ...(pkg.attribution === undefined ? {} : { attribution: pkg.attribution }),
    }, materials, "package");
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
        // Every control now publishes what its verifier actually reported. The
        // known-bad control is no longer inverted: it publishes `refuted` when its
        // verifier refuted the behavior, and the receipt is read literally. An
        // inversion could only ever say "this control did not do what a passing
        // control does", which a crash satisfies just as well as a refusal.
        const outcome = item.outcome === "custody-invalid" ? "unknown" : item.outcome;
        return {
            outcome,
            outcomeReason: item.outcome === "custody-invalid" ? "custody_failed" : item.outcomeReason,
            resultDigest: item.resultDigest,
        };
    };
    return {
        schemaVersion: "continuity-qualification/v1",
        // How this package's verifiers reported their verdicts travels with the
        // receipt. Without it every stored receipt looks pre-protocol, and the
        // control plane cannot say which bindings were qualified by a runner that
        // could tell a crash from a refusal and which rest on a bare exit status.
        // An exit-code-only package can never publish `refuted`, so it can never
        // qualify; saying so on the receipt is what makes that visible rather than
        // merely true.
        resultProtocol: pkg.results?.protocol ?? "exit-code-only",
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
export async function scaffoldPackage(outputPath, promiseId = "prom_example01", executionRoot = process.cwd(), 
// The four facts, when the caller read them off the promise first. Without
// them the starter is written with placeholders, and `seal` refuses those, so
// the omission is caught at the desk rather than in a red check that could
// not say who to talk to.
facts = SCAFFOLD_FACT_PLACEHOLDERS) {
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
        results: { protocol: "native" },
        attribution: { owner: facts.owner, promiseUrl: facts.promiseUrl },
        materials: [
            { path: verifierPath, kind: "verifier" },
            { path: fixturePath, kind: "fixture" },
        ],
    };
    const verifier = scaffoldVerifierProgram(promiseId, facts);
    const fixture = '{\n  "replaceMe": true\n}\n';
    const readme = `# Continuity starter\n\nThis directory was generated locally for **${promiseId}**. It is an authoring starter, not a protected behavior.\n\n1. Replace every placeholder in drafts/${promiseId}.json, including the \`attribution\` block: \`owner\` is the name the promise's meaning owner is known by, and \`promiseUrl\` is the promise's page in Balladeer. Both are read off the promise itself, and \`seal\` refuses a draft that still has the placeholders.\n2. Replace promises/${promiseId}/verifier.mjs with a real verifier and update promises/${promiseId}/fixture.json. The starter verifier only demonstrates control wiring and the native result protocol: it writes {"schemaVersion":"continuity-verifier-result/v1","outcome":"passed"|"refuted"|"errored","examples":{"total":N,"refuted":N,"errored":N}} at the BALLADEER_RESULT_PATH the runner exports. A verifier that reports nothing there can never say a behavior was refuted, so its package can never qualify.\n\n   Keep the four BALLADEER_PROMISE_ constants at the top and keep printing them when the behavior is refuted. They are what makes \`node ${verifierPath}\` on your own machine say the same four things the protected CI check says: which promise broke, the sentence its owner agreed to, who owns it, and where to read it.\n3. From the repository root, seal it into ${outputPath}/packages/${promiseId}.json:\n\n   continuity-runner seal ${draftPath} ${outputPath}/packages/${promiseId}.json\n\nThe seal command refuses to overwrite an existing output. Run the local qualification controls before asking the Balladeer owner to activate the package. No source, fixture contents, or verifier output is sent to Balladeer; only closed digests and normalized outcomes are publishable.\n`;
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
export const UNSHARDED = { index: 0, count: 1 };
export function validateShardCoordinates(shard) {
    const { index, count } = shard;
    if (!Number.isSafeInteger(count) || count < 1 || count > 4096)
        throw new Error("shard count must be an integer between 1 and 4096");
    if (!Number.isSafeInteger(index) || index < 0 || index >= count)
        throw new Error("shard index must be an integer inside the shard count");
    return { index, count };
}
/**
 * The one rule that decides which shard owns which promise: round robin over
 * the frozen manifest's own order.
 *
 * It is deterministic, so every shard, the merge, and the control plane agree
 * on the partition without exchanging a word about it, and it needs nothing but
 * the manifest each of them already holds. Round robin rather than contiguous
 * blocks because manifest order is promise-id order, which correlates with
 * directory layout and therefore with cost: a contiguous block hands one shard
 * every slow verifier in a subsystem, and the fan-out is only as fast as its
 * slowest shard.
 *
 * Every shard validates the WHOLE manifest digest before slicing, so sharding
 * never widens what a run will accept. It only narrows what one job executes.
 */
export function shardOwnerOf(manifestIndex, shardCount) {
    return manifestIndex % shardCount;
}
/**
 * The slice of a resolved manifest one shard runs. The input must be the full
 * ordered selection for the frozen manifest, which is what `selectManifestEntries`
 * returns; slicing anything else would silently change the partition.
 */
export function shardSelections(selections, shard) {
    const { index, count } = validateShardCoordinates(shard);
    if (count === 1)
        return [...selections];
    return selections.filter((_entry, position) => shardOwnerOf(position, count) === index);
}
/**
 * Run the selected manifest entries serially. Target mode produces one result
 * per entry and exercise mode produces one per control, so the count the
 * control plane checks against the frozen manifest is the same whether a
 * package ran or was unavailable.
 *
 * Serial is deliberate inside one shard: customer verifiers may share a
 * database, a queue, a port, or a fixture directory, and `docs/github-ci.md`
 * refuses to run them concurrently in one checkout for exactly that reason.
 * Concurrency is bought by adding shards, each with its own checkout, never by
 * overlapping two verifiers in one.
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
                : closedResult(selection.promiseId, selection.packageDigest, control, new Date(), sourceSha, "custody-invalid", "custody_failed", null, "invalid", 
                // No package answered for this promise, so no result protocol was
                // used. The custody outcome is what the row is about.
                "exit-code-only"));
    return results;
}
export const RUN_OUTPUT_SCHEMA = "continuity-run-output/v1";
export function runOutputDocument(mode, manifest, shard, results) {
    return {
        schemaVersion: RUN_OUTPUT_SCHEMA,
        mode,
        manifestDigest: manifest.manifestDigest,
        shard: validateShardCoordinates(shard),
        sourceSha: results[0]?.sourceSha ?? null,
        results,
    };
}
export function validateRunOutputDocument(input) {
    keysAre(input, ["schemaVersion", "mode", "manifestDigest", "shard", "sourceSha", "results"], "run output");
    if (input.schemaVersion !== RUN_OUTPUT_SCHEMA)
        throw new Error("run output schemaVersion is invalid");
    if (input.mode !== "target" && input.mode !== "exercise")
        throw new Error("run output mode is invalid");
    digestField(input.manifestDigest, "run output manifestDigest");
    keysAre(input.shard, ["index", "count"], "run output shard");
    const shard = validateShardCoordinates(input.shard);
    if (input.sourceSha !== null && !isGitSha(input.sourceSha))
        throw new Error("run output sourceSha must be null or an exact 40-hex commit SHA");
    if (!Array.isArray(input.results))
        throw new Error("run output results must be an array");
    const results = input.results.map(validateResult);
    return { ...input, shard, results };
}
/**
 * Join every shard's closed results into the one document the publisher posts.
 *
 * Robert's ruling, and the reason this exists: a dead shard costs Unknown for
 * ITS OWN promises and for nothing else. Before sharding, one job carried the
 * whole catalog and one failure took every promise in the repository to
 * Unknown; the fan-out would repeat that at a larger scale if a missing shard
 * simply shrank the published set, because the control plane's cardinality
 * check is exact and would refuse the whole publication.
 *
 * So the merge answers for the promises nobody answered for. It mints one
 * closed `errored` result per unreported promise, carrying the reason
 * `shard_failed`, which says an infrastructure failure of Balladeer's own
 * verification fan-out left the behavior unmeasured. It is never `refuted`: no
 * verifier ran, so nothing was refuted, and a caught regression is the one
 * thing this must never be mistaken for.
 *
 * Cardinality therefore stays exact. The publisher still sends exactly one
 * result per frozen manifest promise, and the control plane's check is
 * untouched.
 */
export function mergeShardOutputs(manifestInput, documents, sourceSha, now = new Date()) {
    const manifest = validateExecutionManifest(manifestInput);
    if (!isGitSha(sourceSha))
        throw new Error("sourceSha must be an exact 40-hex commit SHA");
    const parsed = documents.map(validateRunOutputDocument);
    const byPromise = new Map();
    const reported = new Set();
    let shardCount;
    const ownerOf = new Map();
    manifest.promises.forEach((entry, position) => ownerOf.set(entry.id, position));
    for (const document of parsed) {
        if (document.mode !== "target")
            throw new Error("shard output is not a target run");
        if (document.manifestDigest !== manifest.manifestDigest)
            throw new Error("shard output was produced against a different frozen manifest");
        if (shardCount === undefined)
            shardCount = document.shard.count;
        else if (shardCount !== document.shard.count)
            throw new Error("shard outputs disagree about how many shards cover the manifest");
        if (reported.has(document.shard.index))
            throw new Error("two outputs claim the same shard index");
        reported.add(document.shard.index);
        for (const result of document.results) {
            const position = ownerOf.get(result.promiseId);
            if (position === undefined)
                throw new Error("shard output carries a promise that is not in the frozen manifest");
            // A shard may only answer for its own slice. Without this a shard that
            // ignored its coordinates could overwrite a healthy shard's verdict.
            if (shardOwnerOf(position, document.shard.count) !== document.shard.index)
                throw new Error("shard output carries a promise from another shard's slice");
            if (result.sourceSha !== sourceSha)
                throw new Error("shard output was produced against a different commit");
            if (byPromise.has(result.promiseId))
                throw new Error("two shard outputs answer for the same promise");
            byPromise.set(result.promiseId, result);
        }
    }
    const count = shardCount ?? 1;
    const unreportedPromiseIds = [];
    const results = manifest.promises.map((entry) => {
        const answered = byPromise.get(entry.id);
        if (answered !== undefined)
            return answered;
        unreportedPromiseIds.push(entry.id);
        return closedResult(entry.id, entry.packageDigest, "target", now, sourceSha, "errored", "shard_failed", null, 
        // Custody is a claim about materials that were actually checked. Nothing
        // was checked here, so this result may not assert a broken seal either:
        // `custody-invalid` would accuse the customer of changing locked
        // material, which is a different and much louder finding than "our job
        // died". The control plane records this reason as custody unverified.
        "local", "exit-code-only");
    });
    const missingShards = Array.from({ length: count }, (_value, index) => index).filter((index) => !reported.has(index));
    return {
        manifestDigest: manifest.manifestDigest,
        reportedShards: [...reported].sort((left, right) => left - right),
        missingShards,
        unreportedPromiseIds,
        results,
    };
}
/**
 * Say what the merge had to answer for. A person reading a red check must be
 * able to tell "our job died" from "your behavior broke" without opening a
 * result document.
 */
export async function announceMerge(report) {
    if (report.missingShards.length === 0 && report.unreportedPromiseIds.length === 0) {
        humanLine(`all ${report.reportedShards.length} verification shard(s) reported; ${report.results.length} result(s) merged in promise order.`);
        return;
    }
    const sentence = `${report.missingShards.length} verification shard(s) did not report (${report.missingShards.join(", ")}), ` +
        `so ${report.unreportedPromiseIds.length} promise(s) read Unknown for this run with reason shard_failed. ` +
        "This is an infrastructure failure of the verification fan-out, not a refuted test, and it leaves every promise that did report untouched.";
    humanLine(sentence);
    annotate("warning", sentence);
    for (const promiseId of report.unreportedPromiseIds)
        humanLine(`${loggable(promiseId, 80)}: no verification job reported. Reason: shard_failed.`);
    await appendJobSummary(report.unreportedPromiseIds.map((promiseId) => `| ${loggable(promiseId, 240).replace(/\|/g, "\\|")} | target | errored (shard_failed) | No verification job reported for this promise. |`));
}
function digestStream(value) {
    return sha256(value);
}
// The control mode deliberately takes no part in the verdict. There is no
// function here mapping a mode to the exit status it expected: a control
// reports what its verifier said, and whether the known-bad control was
// supposed to be refuted is a qualification question, not a runner one.
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
    if (input.schemaVersion !== RESULT_SCHEMA)
        throw new Error(`result.schemaVersion must be ${RESULT_SCHEMA}`);
    if (!RUN_MODES.includes(input.control))
        throw new Error("result.control is invalid");
    if (!RUN_OUTCOMES.includes(input.outcome))
        throw new Error("result.outcome is invalid");
    if (input.outcomeReason !== null &&
        !OUTCOME_REASONS.includes(input.outcomeReason))
        throw new Error("result.outcomeReason is invalid");
    if ((input.outcome === "pass" || input.outcome === "refuted") !== (input.outcomeReason === null))
        throw new Error("result.outcomeReason must be present for every outcome but pass and refuted");
    if (input.signal !== null && !RESULT_SIGNALS.includes(input.signal))
        throw new Error("result.signal is invalid");
    if (!["native", "junit", "exit-code-only"].includes(input.resultProtocol))
        throw new Error("result.resultProtocol is invalid");
    if (input.resultDocumentDigest !== null)
        digestField(input.resultDocumentDigest, "result.resultDocumentDigest");
    for (const key of ["exampleTotal", "exampleRefuted"]) {
        const value = input[key];
        if (value !== null &&
            (typeof value !== "number" ||
                !Number.isSafeInteger(value) ||
                value < 0 ||
                value > exampleCountLimit))
            throw new Error(`result.${key} is invalid`);
    }
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
/**
 * Two outcomes are annotated as GitHub errors, and they are errors for
 * different reasons. `refuted` is the only caught regression: a verifier ran to
 * completion and reported that the behavior no longer holds. `custody-invalid`
 * is not a regression and never blames the customer's code, but it is not "the
 * check could not run" either: digest-locked material changed, so no result
 * from this run can be trusted, and that is a red an owner has to act on rather
 * than a condition that may clear itself on the next push.
 *
 * Everything else that is not a pass is a warning. A crash, a timeout, or an
 * external cancellation leaves the behavior unmeasured, and painting it the
 * same red as a refutation is exactly the conflation this protocol removes.
 */
function annotationLevel(outcome) {
    if (outcome === "pass")
        return "notice";
    if (outcome === "refuted" || outcome === "custody-invalid")
        return "error";
    return "warning";
}
/**
 * What a local target run leaves behind as its exit status.
 *
 * A local run of a promise's own verifier used to exit 0 whatever it found, so
 * a coder's `&&` chain carried on past a refutation and their editor showed a
 * green tick over a broken behavior. A local red has to be red.
 *
 * The statuses are separated rather than collapsed into one, for the same
 * reason the outcomes are: a script that treats "the behavior broke" and "the
 * check could not run" identically has thrown away the distinction this whole
 * protocol exists to keep. Anything non-zero is a red; which red it is says
 * what to do about it.
 *
 * This is the LOCAL contract only. The CI command keeps exiting 0 on a
 * refutation on purpose: its job is to publish the evidence, and a job step
 * that failed before the publish step would turn a caught regression into an
 * outage of the thing that reports caught regressions.
 */
export const LOCAL_EXIT_STATUS = {
    pass: 0,
    /** The behavior no longer holds. */
    refuted: 1,
    /** Nothing ran, or nothing finished: the behavior is unmeasured, not broken. */
    errored: 3,
    timed_out: 3,
    canceled: 3,
    /** Digest-locked material changed, so no result from this run can be trusted. */
    "custody-invalid": 4,
};
/** What a local target run exits with, and the sentence that explains it. */
export function localTargetExit(result) {
    const status = LOCAL_EXIT_STATUS[result.outcome];
    if (status === 0)
        return { status, explanation: "the behavior holds; exiting 0 because the target run passed" };
    if (result.outcome === "refuted")
        return {
            status,
            explanation: "exiting 1 because the target run refuted this promise: the behavior a named person agreed to no longer holds",
        };
    if (result.outcome === "custody-invalid")
        return {
            status,
            explanation: "exiting 4 because digest-locked material changed, so nothing this run produced can be trusted; this is not a statement about the behavior",
        };
    return {
        status,
        explanation: "exiting 3 because the check could not run to a verdict, so the behavior is unmeasured rather than broken",
    };
}
/** Say why the local run is exiting the way it is, and hand back the status. */
export function reportLocalTargetExit(result) {
    const { status, explanation } = localTargetExit(result);
    humanLine(explanation);
    return status;
}
async function appendJobSummary(rows) {
    const path = process.env.GITHUB_STEP_SUMMARY;
    if (!path || rows.length === 0)
        return;
    const table = [
        "### Balladeer continuity attestor",
        "",
        "| Promise | Owner | Promise page | Control | Outcome | Detail |",
        "| --- | --- | --- | --- | --- | --- |",
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
 * Who owns the promise, said so a person can act on it.
 *
 * The sealed package carries a name when it was sealed by a runner that asks
 * for one. When it does not, the membership id in the approved meaning is what
 * exists, and printing it is better than printing nothing: it is the string the
 * promise page resolves to a person. Either way the field is always there, so
 * "no owner" is never a thing this line can quietly say.
 */
function announcedOwner(pkg) {
    if (pkg === undefined)
        return "not available: no sealed package for this promise";
    if (pkg.attribution !== undefined)
        return loggable(pkg.attribution.owner, 160);
    return `${loggable(pkg.promise.ownerId, 80)} (membership id; re-seal this package to name the owner)`;
}
/**
 * Where the promise itself can be read.
 *
 * The runner is offline and holds no origin of its own, so the only honest
 * source is the sealed package. A package sealed before this member existed
 * says so rather than guessing at a hostname, because a link that 404s is worse
 * than a sentence that names the repair.
 */
function announcedPage(pkg) {
    if (pkg?.attribution !== undefined)
        return loggable(pkg.attribution.promiseUrl, 2_000);
    return "not sealed into this package; re-seal it with the promise page to link it here";
}
/**
 * Say what happened, in the customer's own job log, for every promise the run
 * covered. This is explanation only: it reads finished results and writes to
 * the human channel, the GitHub annotation stream, and the job summary. It
 * never changes a result and never adds a field to what is published.
 *
 * Every line names four things: which promise, the sentence its owner approved,
 * who owns it, and where to read it. That is what turns a red check into
 * something a coder can act on without opening a browser to find out what broke
 * or asking around for who agreed to it. The same four go into all three
 * channels, because a person reading the annotation and a person reading the
 * job summary must not be told different amounts.
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
        const context = reason !== ""
            ? reason
            : approvedOutcome === ""
                ? ""
                : `Approved observable outcome: ${approvedOutcome}`;
        // The reason code says which kind of not-pass this is, so a person reading
        // the log is never left to guess whether the behavior broke or the check
        // could not run.
        const outcomeReason = result.outcomeReason === null ? "" : `Reason: ${result.outcomeReason}.`;
        const owner = announcedOwner(pkg);
        const page = announcedPage(pkg);
        const detail = [outcomeReason, context].filter((part) => part !== "").join(" ");
        const named = `${result.outcome}${result.outcomeReason === null ? "" : ` (${result.outcomeReason})`}`;
        // The four facts, in one sentence, in the order a person needs them: which
        // promise, what was agreed, who agreed it, where to read it.
        const sentence = `${subject}: ${result.control} control outcome ${named}.${detail === "" ? "" : ` ${detail}`} Owner: ${owner}. Promise page: ${page}`;
        humanLine(sentence);
        // Only a refutation is a caught regression, and a custody failure is the
        // one other outcome that earns a red: the material changed, so nothing this
        // run produced can be trusted. A crash, a timeout, or a cancellation is a
        // warning, because it never blames the customer's code for breaking a
        // behavior nobody managed to check.
        annotate(annotationLevel(result.outcome), sentence);
        rows.push(`| ${cell(subject, 240)} | ${cell(owner, 160)} | ${cell(page, 2_000)} | ${result.control} | ${named} | ${cell(detail, 240)} |`);
    }
    await appendJobSummary(rows);
}
/**
 * Customer verifiers are untrusted processes. They need a minimal operating
 * environment, not the Actions control plane: in particular they must never
 * inherit OIDC, GitHub file-command, artifact, runner, or checkout metadata.
 * There is intentionally no package-level arbitrary env passthrough.
 *
 * `BALLADEER_RESULT_PATH` is the one variable the runner adds, and only when
 * the package declares a result protocol. It names the absolute path the
 * verifier writes its verdict document to. It is not a passthrough: the runner
 * chooses the value.
 */
export function verifierEnvironment(
// Any environment map, not the process's own type. This reads an allow-list
// of names and nothing else, and a caller handing it a constructed
// environment, to prove that a control-plane variable really is dropped, is
// exactly the case worth testing.
environment = process.env, resultPath) {
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
    if (resultPath)
        clean.BALLADEER_RESULT_PATH = resultPath;
    return clean;
}
// ---------------------------------------------------------------------------
// Reading a verifier's verdict document.
//
// The document is read for four enums and three integers. No element text, no
// failure message, no test name, and no path is ever read out of it, so the
// runner still imports nothing but node: modules and nothing a customer wrote
// can travel further than a count. Its bytes are digested so that the control
// plane can bind the verdict to the document that produced it, and the bytes
// themselves never leave the customer's runner.
// ---------------------------------------------------------------------------
/** The same 16 MiB bound the locked-material check already uses. */
const resultDocumentLimit = 16 * 1024 * 1024;
const junitRootScanLimit = 64 * 1024;
const junitSuiteLimit = 10_000;
function boundedCount(value) {
    if (typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > exampleCountLimit)
        return undefined;
    return value;
}
function countAttribute(element, name) {
    const match = new RegExp(`\\s${name}="([^"]*)"`).exec(element);
    if (!match)
        return undefined;
    const text = match[1].trim();
    if (!/^[0-9]{1,7}$/.test(text))
        return undefined;
    return boundedCount(Number(text));
}
function junitCounts(text) {
    const totals = { tests: 0, failures: 0, errors: 0, skipped: 0 };
    const root = /<testsuites\b[^>]*>/.exec(text.slice(0, junitRootScanLimit));
    const children = text.match(/<testsuite\b[^>]*>/g) ?? [];
    // The root carries the totals when it states them, and the child suites are
    // summed when it does not.
    const rootTotals = root !== null && countAttribute(root[0], "tests") !== undefined ? root[0] : undefined;
    const suites = rootTotals === undefined ? children : [rootTotals];
    if (suites.length === 0 || suites.length > junitSuiteLimit)
        return undefined;
    for (const suite of suites) {
        const tests = countAttribute(suite, "tests");
        if (tests === undefined)
            return undefined;
        const failures = countAttribute(suite, "failures") ?? 0;
        const errors = countAttribute(suite, "errors") ?? 0;
        const skipped = countAttribute(suite, "skipped") ?? 0;
        if (skipped > tests)
            return undefined;
        totals.tests += tests;
        totals.failures += failures;
        totals.errors += errors;
        totals.skipped += skipped;
    }
    // A skip is the one count a `<testsuites>` root is routinely allowed to omit.
    // jest-junit writes a root of exactly `name tests failures errors time` and
    // records `skipped` only on each child suite, so a report whose every example
    // was skipped reads, from the root alone, as forty tests that passed. That is
    // the same class of defect as a crash reading as a pass, on the run an owner
    // trusts most, so when the root does not say how many were skipped the
    // children are asked. A count that cannot be reconciled with the root's own
    // total is not a report this runner will take a verdict from.
    if (rootTotals !== undefined && countAttribute(rootTotals, "skipped") === undefined) {
        if (children.length > junitSuiteLimit)
            return undefined;
        let childSkipped = 0;
        for (const suite of children)
            childSkipped += countAttribute(suite, "skipped") ?? 0;
        if (childSkipped > totals.tests)
            return undefined;
        totals.skipped = childSkipped;
    }
    if (Object.values(totals).some((value) => boundedCount(value) === undefined))
        return undefined;
    // A suite that reports errors did not decide the behavior, whatever else it
    // reports. A suite that reports failures and no errors refuted it.
    const outcome = totals.errors > 0 ? "errored" : totals.failures > 0 ? "refuted" : "passed";
    return {
        outcome,
        counts: {
            executed: totals.tests - totals.skipped,
            refuted: totals.failures,
            errored: totals.errors,
        },
    };
}
function nativeCounts(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return undefined;
    const document = parsed;
    for (const key of Object.keys(document))
        if (!["schemaVersion", "outcome", "examples"].includes(key))
            return undefined;
    if (document.schemaVersion !== "continuity-verifier-result/v1")
        return undefined;
    const outcome = document.outcome;
    if (outcome !== "passed" && outcome !== "refuted" && outcome !== "errored")
        return undefined;
    const examples = document.examples;
    if (!examples || typeof examples !== "object" || Array.isArray(examples))
        return undefined;
    const counts = examples;
    for (const key of Object.keys(counts))
        if (!["total", "refuted", "errored", "skipped"].includes(key))
            return undefined;
    const total = boundedCount(counts.total);
    const refuted = boundedCount(counts.refuted);
    const errored = boundedCount(counts.errored);
    const skipped = counts.skipped === undefined ? 0 : boundedCount(counts.skipped);
    if (total === undefined ||
        refuted === undefined ||
        errored === undefined ||
        skipped === undefined ||
        skipped > total ||
        refuted > total)
        return undefined;
    return { outcome, counts: { executed: total - skipped, refuted, errored } };
}
async function readResultDocument(path, protocol) {
    let info;
    try {
        info = await lstat(path);
    }
    catch {
        return { kind: "absent" };
    }
    // A verifier that replaced the document with a link is not writing a verdict.
    if (!info.isFile())
        return { kind: "unreadable" };
    if (info.size === 0)
        return { kind: "absent" };
    if (info.size > resultDocumentLimit)
        return { kind: "too_large" };
    let bytes;
    try {
        bytes = await readFile(path);
    }
    catch {
        return { kind: "unreadable" };
    }
    if (bytes.byteLength === 0)
        return { kind: "absent" };
    if (bytes.byteLength > resultDocumentLimit)
        return { kind: "too_large" };
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const parsed = protocol === "native"
        ? nativeCounts(bytes.toString("utf8"))
        : junitCounts(bytes.toString("utf8"));
    if (!parsed)
        return { kind: "unparseable", digest };
    return { kind: "verdict", digest, outcome: parsed.outcome, counts: parsed.counts };
}
/**
 * Turn a finished process plus its verdict document into exactly one closed
 * outcome. This is the whole of the discrimination claim: a crash is never a
 * pass and is never a refutation, and no path through here can report `refuted`
 * without a document that said so.
 */
function classifyReading(reading, exitCode) {
    if (reading.kind === "absent")
        // A declared protocol that wrote nothing and exited non-zero crashed before
        // it could report; the same silence with a clean exit is a missing document.
        return { outcome: "errored", reason: exitCode !== 0 ? "nonzero_exit" : "result_missing" };
    if (reading.kind === "too_large")
        return { outcome: "errored", reason: "result_too_large" };
    if (reading.kind === "unreadable" || reading.kind === "unparseable")
        return { outcome: "errored", reason: "result_unparseable" };
    if (reading.outcome === "errored" || reading.counts.errored > 0)
        return { outcome: "errored", reason: "verifier_reported_error", counts: reading.counts };
    // Only the direction that could hide a failure is checked. A refutation
    // reported by a document whose process exited 0 stays a refutation: plenty of
    // real pipelines swallow the exit status, and understating health is safe
    // where overstating it is not.
    if (reading.outcome === "passed" && exitCode !== 0)
        return { outcome: "errored", reason: "result_disagrees_exit", counts: reading.counts };
    if (reading.counts.executed === 0)
        return { outcome: "errored", reason: "no_examples_ran", counts: reading.counts };
    if (reading.outcome === "refuted")
        return { outcome: "refuted", reason: null, counts: reading.counts };
    return { outcome: "pass", reason: null, counts: reading.counts };
}
function closedSignal(signal) {
    if (!signal)
        return null;
    return RESULT_SIGNALS.includes(signal) ? signal : "other";
}
/**
 * Where the native verdict document lives: a runner-chosen file outside the
 * repository. It is deliberately not a declared package path, because every
 * regular file under `.continuity/promises/<id>/` must be digest-locked, and a
 * document written there during the good control would make every later control
 * custody-invalid.
 */
function nativeResultPath() {
    const temporary = process.env.RUNNER_TEMP;
    const base = temporary && isAbsolute(temporary) ? temporary : tmpdir();
    return pathResolve(base, `balladeer-verifier-result-${randomUUID()}.json`);
}
export async function runVerifier(pkgInput, control, executionRoot = process.cwd(), sourceSha = process.env.BALLADEER_SOURCE_SHA ?? process.env.GITHUB_SHA) {
    const pkg = validatePackage(pkgInput);
    if (!isGitSha(sourceSha))
        throw new Error("sourceSha must be an exact 40-hex commit SHA");
    const spec = pkg.verifier[control];
    const protocol = pkg.results?.protocol;
    const resultProtocol = protocol ?? "exit-code-only";
    const started = new Date();
    const custodyInvalid = () => closedResult(pkg.promise.id, pkg.packageDigest, control, started, sourceSha, "custody-invalid", "custody_failed", null, "invalid", resultProtocol);
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
    // Resolve the verdict document's path before the process starts, under the
    // same closure and symlink rules the locked materials get. A JUnit report is
    // named by the package relative to the command's own working directory, which
    // is the base the test runner writes to; a native document is the runner's
    // own temporary file.
    let resultPath;
    if (protocol === "native")
        resultPath = nativeResultPath();
    else if (protocol === "junit") {
        const declared = pkg.results.file;
        const target = pathResolve(cwd, declared);
        let parent;
        try {
            parent = await realpath(dirname(target));
        }
        catch {
            return custodyInvalid();
        }
        const relativeParent = relative(root, parent);
        if (relativeParent.startsWith("..") || isAbsolute(relativeParent))
            return custodyInvalid();
        resultPath = pathResolve(parent, basename(target));
        const existing = await lstat(resultPath).catch(() => undefined);
        if (existing && (existing.isSymbolicLink() || !existing.isFile()))
            return custodyInvalid();
    }
    // A document left behind by an earlier run is a replay vector: after this,
    // absence once the process has exited means the verifier never wrote one.
    if (resultPath)
        await unlink(resultPath).catch(() => undefined);
    return new Promise((settle) => {
        const echo = outputEcho(pkg.promise.id, control);
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const stdoutHash = createHash("sha256");
        const stderrHash = createHash("sha256");
        let settled = false;
        let exited = false;
        let forcedOutcome;
        let forcedReason;
        const child = spawn(spec.executable, spec.args, {
            cwd,
            shell: false,
            detached: true,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            // Deliberately not the ambient environment: this is the closed allow-list
            // the child gets instead of it, so it is stated as such rather than
            // inheriting the shape of `process.env`.
            env: verifierEnvironment(process.env, resultPath),
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
        // A runner-initiated stop carries both the outcome and the reason, so the
        // process group's own SIGTERM can never be mistaken for a CI cancellation.
        const stop = (outcome, reason) => {
            if (forcedOutcome === undefined) {
                forcedOutcome = outcome;
                forcedReason = reason;
            }
            terminateGroup("SIGTERM");
            killTimer ??= setTimeout(() => terminateGroup("SIGKILL"), 250);
        };
        const updateOutput = (chunk, stream) => {
            if (stream === "stdout") {
                stdoutBytes += chunk.byteLength;
                stdoutHash.update(chunk);
                if (stdoutBytes > outputLimit)
                    stop("errored", "output_limit");
            }
            else {
                stderrBytes += chunk.byteLength;
                stderrHash.update(chunk);
                if (stderrBytes > outputLimit)
                    stop("errored", "output_limit");
            }
            // The digest above covers every raw byte. The echo below is a bounded,
            // sanitized copy for the customer's own job log and changes nothing that
            // is published.
            echo.add(chunk, stream);
        };
        child.stdout.on("data", (chunk) => updateOutput(chunk, "stdout"));
        child.stderr.on("data", (chunk) => updateOutput(chunk, "stderr"));
        const timer = setTimeout(() => stop("timed_out", "timeout"), timeout);
        let exitCodeSeen = null;
        let signalSeen = null;
        let spawnFailed = false;
        let closed = false;
        let graceTimer;
        /**
         * Exactly one closed outcome, derived in this order: custody, spawn
         * failure, runner-initiated timeout, output limit, external cancellation,
         * any other signal, then the verdict document. Nothing below the signal
         * rows can reach `pass` or `refuted` without a document that said so.
         */
        const finish = async () => {
            if (settled || !exited)
                return;
            settled = true;
            clearTimeout(timer);
            if (killTimer)
                clearTimeout(killTimer);
            if (graceTimer)
                clearTimeout(graceTimer);
            echo.flush();
            let outcome;
            let reason;
            let exitCode = exitCodeSeen;
            let counts;
            let documentDigest = null;
            if (spawnFailed) {
                outcome = "errored";
                reason = "spawn_failed";
                exitCode = null;
            }
            else if (forcedOutcome !== undefined) {
                outcome = forcedOutcome;
                reason = forcedReason ?? "timeout";
                exitCode = null;
            }
            else if (signalSeen === "SIGTERM" || signalSeen === "SIGINT") {
                // Nothing in this runner sent it, so someone outside did: a cancelled
                // CI run, not a verdict about the behavior.
                outcome = "canceled";
                reason = "canceled_external";
            }
            else if (signalSeen) {
                // A segmentation fault or an abort is a crash. Calling it `canceled`
                // would spend an evidence-lifecycle word on a broken verifier.
                outcome = "errored";
                reason = "signal_killed";
            }
            else if (protocol === undefined) {
                outcome = exitCode === 0 ? "pass" : "errored";
                reason = exitCode === 0 ? null : "protocol_undeclared";
            }
            else {
                const reading = await readResultDocument(resultPath, protocol);
                if (reading.kind === "unparseable" || reading.kind === "verdict")
                    documentDigest = reading.digest;
                const classified = classifyReading(reading, exitCode);
                outcome = classified.outcome;
                reason = classified.reason;
                counts = classified.counts;
            }
            if (resultPath)
                await unlink(resultPath).catch(() => undefined);
            const completed = new Date();
            const base = {
                schemaVersion: RESULT_SCHEMA,
                runnerVersion: RUNNER_VERSION,
                promiseId: pkg.promise.id,
                packageDigest: pkg.packageDigest,
                sourceSha,
                control,
                outcome,
                outcomeReason: reason,
                exitCode,
                signal: closedSignal(signalSeen),
                durationMs: Math.max(0, completed.getTime() - started.getTime()),
                stdoutDigest: `sha256:${stdoutHash.digest("hex")}`,
                stderrDigest: `sha256:${stderrHash.digest("hex")}`,
                resultProtocol,
                resultDocumentDigest: documentDigest,
                exampleTotal: counts?.executed ?? null,
                exampleRefuted: counts?.refuted ?? null,
                startedAt: started.toISOString(),
                completedAt: completed.toISOString(),
                custody: "local",
            };
            settle({ ...base, resultDigest: resultDigest(base) });
        };
        child.once("error", () => {
            spawnFailed = true;
            exited = true;
            void finish();
        });
        child.once("close", () => {
            closed = true;
            if (exited)
                void finish();
        });
        child.once("exit", (code, signal) => {
            exitCodeSeen = code;
            signalSeen = signal;
            exited = true;
            // Settle once the pipes are closed, so a document written by a
            // grandchild is fully flushed before it is read and digested. A
            // grandchild that holds the pipes open forever must not hold the run
            // open with it, so the wait is bounded.
            if (closed)
                void finish();
            else
                graceTimer = setTimeout(() => void finish(), 250);
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
function closedResult(promiseId, packageDigest, control, started, sourceSha, outcome, outcomeReason, exitCode, custody, resultProtocol) {
    const completed = new Date();
    const base = {
        schemaVersion: RESULT_SCHEMA,
        runnerVersion: RUNNER_VERSION,
        promiseId,
        packageDigest,
        sourceSha,
        control,
        outcome,
        outcomeReason,
        exitCode,
        signal: null,
        durationMs: Math.max(0, completed.getTime() - started.getTime()),
        stdoutDigest: sha256(""),
        stderrDigest: sha256(""),
        resultProtocol,
        resultDocumentDigest: null,
        exampleTotal: null,
        exampleRefuted: null,
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
/** What each control must report for the verifier to have discriminated. */
const discriminatingOutcome = {
    good: "pass",
    bad: "refuted",
    refactor: "pass",
};
/**
 * A verifier discriminates when the good and refactor controls report `pass`
 * and the known-bad control reports `refuted`. A crashed known-bad control used
 * to satisfy this, because "not a pass" was all that was asked of it; now only
 * a verifier that actually refused the behavior does.
 */
export function exerciseDiscriminates(results) {
    const promiseIds = new Set(results.map((result) => result.promiseId));
    return (promiseIds.size > 0 &&
        [...promiseIds].every((promiseId) => CONTROLS.every((control) => results.filter((result) => result.promiseId === promiseId && result.control === control)
            .length === 1 &&
            results.some((result) => result.promiseId === promiseId &&
                result.control === control &&
                result.outcome === discriminatingOutcome[control]))));
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
    // A control that could not decide is counted separately from one that
    // decided the wrong way. Both leave the package unqualified, and only the
    // second says anything about the verifier's behavior.
    const undecided = (items) => items.filter((result) => result.outcome === "errored" ||
        result.outcome === "timed_out" ||
        result.outcome === "canceled").length;
    const perPromise = packages.map((pkg) => {
        const ownResults = results.filter((result) => result.promiseId === pkg.promise.id);
        const tamper = tamperControls.find((item) => item.promiseId === pkg.promise.id);
        // A metadata mutation is not an executed tamper control. Qualification
        // must be based on the real material mutation exercised by
        // `qualification-request`; callers that did not run it stay unknown.
        const tamperDetected = tamper?.outcome === "detected";
        return {
            promiseId: pkg.promise.id,
            controlsDiscriminated: exerciseDiscriminates(ownResults),
            undecidedControls: undecided(ownResults),
            resultProtocol: pkg.results?.protocol ?? "exit-code-only",
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
        allControlsDiscriminated: sourceShaConsistent && perPromise.every((item) => item.controlsDiscriminated),
        undecidedControls: undecided(results),
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
        // The export carries a sealed package, so it keeps the package schema. The
        // results inside it carry their own result schema.
        schemaVersion: RUNNER_SCHEMA,
        exportedAt: new Date().toISOString(),
        package: pkg,
        results,
        runnable: true,
    };
}
