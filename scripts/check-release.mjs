import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const expected = new Set([
  ".gitignore",
  ".gitattributes",
  "CLAUDE.md",
  "LICENSE",
  "README.md",
  "RELEASE-POLICY.md",
  "SECURITY-REVIEW.md",
  "SECURITY.md",
  "TRUST-BOUNDARY.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  ".github/CODEOWNERS",
  ".github/workflows/continuity-attestor.yml",
  ".github/workflows/release-integrity.yml",
  "release/continuity-runner/cli.js",
  "release/continuity-runner/index.js",
  "scripts/check-release.mjs",
  "scripts/check-runner-reproducible.mjs",
  "scripts/smoke-runner.mjs",
  "packages/continuity-runner/package.json",
  "packages/continuity-runner/tsconfig.json",
  "packages/continuity-runner/tsconfig.release.json",
  "packages/continuity-runner/src/cli.ts",
  "packages/continuity-runner/src/index.ts",
]);

async function filesUnder(path, result = []) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist"].includes(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) await filesUnder(child, result);
    else if (entry.isFile()) result.push(relative(root, child));
  }
  return result;
}

const files = (await filesUnder(root)).sort();
const inventory = new Set(files);
const unexpected = files.filter((file) => !expected.has(file));
const missing = [...expected].filter((file) => !inventory.has(file)).sort();
if (unexpected.length || missing.length) {
  console.error(JSON.stringify({ unexpected, missing }, null, 2));
  process.exit(1);
}

const contents = new Map(
  await Promise.all(files.map(async (file) => [file, await readFile(join(root, file), "utf8")])),
);
const workflow = contents.get(".github/workflows/continuity-attestor.yml");
const integrityWorkflow = contents.get(".github/workflows/release-integrity.yml");
const runner = contents.get("packages/continuity-runner/src/index.ts");
const runnerCli = contents.get("packages/continuity-runner/src/cli.ts");
const readme = contents.get("README.md");
const security = contents.get("SECURITY.md");
const trustBoundary = contents.get("TRUST-BOUNDARY.md");
const securityReview = contents.get("SECURITY-REVIEW.md");
const claude = contents.get("CLAUDE.md");
const license = contents.get("LICENSE");
const codeowners = contents.get(".github/CODEOWNERS");
const packageJson = JSON.parse(contents.get("package.json"));
const runnerPackageJson = JSON.parse(contents.get("packages/continuity-runner/package.json"));
const lockfile = await stat(join(root, "pnpm-lock.yaml"));

const controlPlaneMatches = [
  ...workflow.matchAll(/^\s*BALLADEER_CONTROL_PLANE_URL:\s*(\S+)\s*$/gm),
];
const audienceMatches = [...workflow.matchAll(/^\s*BALLADEER_OIDC_AUDIENCE:\s*(\S+)\s*$/gm)];
const actionLines = [...workflow.split("\n"), ...integrityWorkflow.split("\n")].filter((line) =>
  /\buses:\s/.test(line),
);
const allText = [...contents.values()].join("\n");
const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bwhsec_[A-Za-z0-9_-]{16,}\b/,
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]{16,}\b/,
  /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@/i,
];
const jobBody = (name) => {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) return "";
  const bodyStart = start + marker.length;
  const remaining = workflow.slice(bodyStart);
  const next = remaining.search(/\n  [a-z][a-z0-9-]*:\n/);
  return next < 0 ? remaining : remaining.slice(0, next);
};
const registerJob = jobBody("register");
const verifyJob = jobBody("verify");
const publishJob = jobBody("publish");
const qualifyControlsJob = jobBody("qualify-controls");
const qualifyPublishJob = jobBody("qualify-publish");
const curlLines = workflow.split("\n").filter((line) => /\bcurl\s/.test(line));

const assertions = [
  [controlPlaneMatches.length === 1, "one control-plane origin constant"],
  [controlPlaneMatches[0]?.[1] === "https://attest.balladeer.ai", "stable CI origin"],
  [audienceMatches.length === 1, "one OIDC audience constant"],
  [audienceMatches[0]?.[1] === "https://attest.balladeer.ai", "fixed OIDC audience"],
  [!allText.includes(["balladeer-envelopes", "fly.dev"].join(".")), "no provider hostname"],
  [!allText.includes(["control.balladeer", "invalid"].join(".")), "no placeholder origin"],
  [!/^\s+(control_plane_url|balladeer_url|oidc_audience):/m.test(workflow), "no caller endpoint inputs"],
  [
    (workflow.match(/repository: \$\{\{ job\.workflow_repository \}\}/g) ?? []).length === 2,
    "GitHub-selected attestor repository",
  ],
  [
    (workflow.match(/ref: \$\{\{ job\.workflow_sha \}\}/g) ?? []).length === 2,
    "GitHub-selected attestor SHA",
  ],
  [
    !workflow.includes("needs.register.outputs.attestor_") &&
      !workflow.includes("steps.register.outputs.attestor_"),
    "server response cannot select executable",
  ],
  [
    (workflow.match(/ATTESTOR_WORKFLOW_REF: \$\{\{ job\.workflow_ref \}\}/g) ?? []).length === 2 &&
      (workflow.match(/ATTESTOR_WORKFLOW_FILE_PATH: \$\{\{ job\.workflow_file_path \}\}/g) ?? [])
        .length === 2,
    "GitHub workflow identity is captured",
  ],
  [
    (workflow.match(/git -C "\$stage_dir" rev-parse HEAD/g) ?? []).length === 2,
    "attestor checkout HEAD is verified",
  ],
  [
    (workflow.match(/\.balladeer-attestor-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ github\.job \}\}/g) ?? [])
      .length === 2,
    "run-derived attestor staging paths",
  ],
  [workflow.includes("release/continuity-runner/cli.js"), "prebuilt runner execution"],
  [!workflow.includes('corepack pnpm --dir "$runner_dir"'), "no customer-side attestor install"],
  [!workflow.includes("corepack pnpm install --frozen-lockfile"), "no hard-coded customer package manager"],
  [!workflow.includes("tsc "), "no customer-side attestor compilation"],
  [
    !workflow.includes("setup_command") && !readme.includes("setup_command"),
    "no unbound customer setup command",
  ],
  [
    (workflow.match(/actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/g) ?? [])
      .length === 2 &&
      (workflow.match(/node-version: 22\.18\.0/g) ?? []).length === 2,
    "source-reading jobs pin Node 22.18.0",
  ],
  [
    (workflow.match(/runs-on: ubuntu-24\.04/g) ?? []).length === 5 &&
      !workflow.includes("ubuntu-latest"),
    "attestor jobs pin Ubuntu 24.04",
  ],
  [(workflow.match(/timeout-minutes:/g) ?? []).length === 5, "every attestor job has a timeout"],
  [
    curlLines.length > 0 &&
      curlLines.every(
        (line) => line.includes("--connect-timeout 10") && line.includes("--max-time 30"),
      ),
    "every curl is time-bounded",
  ],
  [
    workflow.includes(".targetId | select(test(") &&
      workflow.includes(".manifestDigest | select(test(") &&
      workflow.includes(".challenge | select(length >= 32 and length <= 256"),
    "registration outputs are validated before GITHUB_OUTPUT",
  ],
  [
    !registerJob.includes("actions/checkout@") &&
      !publishJob.includes("actions/checkout@") &&
      !qualifyPublishJob.includes("actions/checkout@"),
    "token-bearing jobs never checkout source",
  ],
  [
    !verifyJob.includes("id-token: write") && !qualifyControlsJob.includes("id-token: write"),
    "source-reading jobs cannot mint OIDC",
  ],
  [workflow.includes("persist-credentials: false"), "checkout credentials disabled"],
  [workflow.includes("permissions: {}"), "default permissions empty"],
  [
    actionLines.every((line) => /@[0-9a-f]{40}(?:\s|$)/.test(line.replace(/\s+#.*$/, ""))),
    "all actions pinned",
  ],
  [!runner.match(/^import\s+(?!type\s+).*from\s+["'](?!node:)/gm), "runner imports only Node modules"],
  [!runner.includes("fetch("), "runner has no network client"],
  [
    !runner.includes("Promise.all(") && !runnerCli.includes("Promise.all("),
    "verifier controls and packages execute serially",
  ],
  [
    runner.includes(".continuity/envelopes/${envelopeId}") &&
      runner.includes("assertExactMaterialClosure") &&
      runner.includes("envelope material tree contains a symbolic link"),
    "closed envelope-owned material tree",
  ],
  [
    !runner.includes("process.stdout") && !runner.includes("console."),
    "the closed result is the only thing the runner writes to stdout",
  ],
  [
    runner.includes("function outputEcho(") &&
      runner.includes("humanPrefix") &&
      runner.includes("controlCharacter"),
    "echoed verifier output is prefixed and stripped of control characters",
  ],
  [
    runner.includes("export function selectManifestEntries") &&
      !runner.includes("selectManifestPackages") &&
      runnerCli.includes("selectManifestEntries") &&
      runnerCli.includes("readAvailablePackages"),
    "one manifest entry yields exactly one custody answer",
  ],
  [
    security.includes("customer's own GitHub job log") &&
      trustBoundary.includes("customer's own GitHub job log"),
    "verifier output is documented as customer-local",
  ],
  [packageJson.private === false, "release package is public"],
  [packageJson.license === "Apache-2.0", "Apache-2.0 package license"],
  [
    packageJson.repository?.url === "https://github.com/Balladeer-Labs/attestor.git",
    "permanent package repository identity",
  ],
  [runnerPackageJson.license === "Apache-2.0", "Apache-2.0 runner license"],
  [runnerPackageJson.version === packageJson.version, "attestor and runner release version agree"],
  [
    runner.includes(`export const RUNNER_VERSION = "${runnerPackageJson.version}"`),
    "runner source and package version agree",
  ],
  [license.includes("Apache License") && license.includes("Version 2.0"), "Apache-2.0 license text"],
  [readme.includes("Balladeer-Labs/attestor"), "permanent repository identity"],
  [
    readme.includes("contents: read") && readme.includes("id-token: write"),
    "caller documents required permissions",
  ],
  [security.includes("https://attest.balladeer.ai"), "documented fixed egress"],
  [
    readme.includes("SECURITY-REVIEW.md") && readme.includes("CLAUDE.md"),
    "cold-start safeguards linked from README",
  ],
  [
    claude.includes("job.workflow_repository") &&
      claude.includes("job.workflow_sha") &&
      claude.includes("control-plane response") &&
      claude.includes("There is no caller-supplied setup hook") &&
      claude.includes("Do not merge, tag, register a production-supported release"),
    "agent instructions preserve executable-selection and release gates",
  ],
  [
    securityReview.includes("Original trust failure") &&
      securityReview.includes("registration response selected an attestor repository and SHA") &&
      securityReview.includes("Exact re-test categories") &&
      securityReview.includes("separate-owner, synthetic GitHub repository") &&
      securityReview.toLowerCase().includes("private control-plane draft pr") &&
      securityReview.includes("https://github.com/Bobby-tables1/balladeer/pull/1"),
    "security review preserves failure, adversarial gates, and paired handoff",
  ],
  [codeowners.includes("@Bobby-tables1"), "release owner"],
  [lockfile.isFile && lockfile.size > 0, "frozen dependency lockfile"],
  [!files.some((file) => file.endsWith(".env") || file.includes("customer")), "no customer or environment files"],
  [
    !allText.includes(["", "Users", ""].join("/")) &&
      !allText.includes([".codex", ""].join("/")),
    "no private filesystem paths",
  ],
  [!allText.toLowerCase().includes(["di", "dero"].join("")), "no design-partner identity"],
  [secretPatterns.every((pattern) => !pattern.test(allText)), "no high-signal secret material"],
];
const failed = assertions.filter(([ok]) => !ok).map(([, label]) => label);
if (failed.length) {
  console.error(`release checks failed: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`release checks passed (${inventory.size} public files)`);
