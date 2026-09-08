import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const workflow = readFileSync(new URL("../.github/workflows/continuity-attestor.yml", import.meta.url), "utf8");
assert.match(workflow, /verify_replay_boundaries:\n(?:.*\n){3}        default: false/);
assert.equal((workflow.match(/VERIFY_REPLAY_BOUNDARIES: \$\{\{ inputs.verify_replay_boundaries && github.event_name == 'push' && github.ref == format\('refs\/heads\/\{0\}', inputs.default_branch\) \}\}/g) ?? []).length, 2);
assert.match(workflow, /verify_pr_qualification_boundary:\n(?:.*\n){3}        default: false/);
assert.equal((workflow.match(/inputs.verify_pr_qualification_boundary && github.event_name == 'pull_request'/g) ?? []).length, 3);
assert.equal((workflow.match(/\(github.event_name == 'push' && github.ref == format\('refs\/heads\/\{0\}', inputs.default_branch\)\) \|\| \(inputs.verify_pr_qualification_boundary && github.event_name == 'pull_request'\)/g) ?? []).length, 2);
const checks = [];
function run(kind, { enabled = true, status, error = "conflict", qualified = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "attestor-replay-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    // The extracted production shell can only invoke this synthetic curl. No network.
    writeFileSync(join(bin, "curl"), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),root=process.env.PROBE_DIR,file=path.join(root,'calls.json');
const calls=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):[];
const body=JSON.parse(fs.readFileSync(args[args.indexOf('--data-binary')+1].slice(1)));
const url=args[args.indexOf('-X')+2];
if(url!=='https://attest.balladeer.ai/api/ci/'+(process.env.PROBE_KIND==='target'?'results':'qualification-receipts'))process.exit(92);
if(!args.includes('--connect-timeout')||!args.includes('--max-time'))process.exit(93);
calls.push(body);fs.writeFileSync(file,JSON.stringify(calls));
const status=process.env.PROBE_STATUS||(process.env.PROBE_KIND==='pr'?'400':(process.env.PROBE_KIND==='target'||calls.length===2)?'409':'200');
fs.writeFileSync(args[args.indexOf('--output')+1],JSON.stringify(status==='400'||status==='409'?{error:process.env.PROBE_ERROR}:{status:'replayed'}));
process.stdout.write(status);
`, { mode: 0o700 });
    const controls = Object.fromEntries(Object.entries({ good: "pass", bad: qualified ? "refuted" : "errored", refactor: "pass", tamper: "detected" }).map(([key, outcome]) => [key, { outcome, resultDigest: `sha256:${"a".repeat(64)}` }]));
    const receipt = { receiptId: "synthetic-receipt", runId: "synthetic-run", runAttempt: 1, controls };
    const target = { targetId: "synthetic-target", runId: "synthetic-run", challenge: "synthetic-challenge" };
    writeFileSync(join(directory, "receipt.json"), JSON.stringify(receipt));
    writeFileSync(join(directory, "publish.json"), JSON.stringify(target));
    const marker = kind === "pr" ? "PR qualification refusal self-check" : `${kind} replay self-check`;
    const start = workflow.indexOf(`# Begin ${marker}`);
    const end = workflow.indexOf(`# End ${marker}`, start);
    assert.ok(start > 0 && end > start);
    const block = workflow.slice(start, end);
    const shell = "set -euo pipefail\ntoken=synthetic-local-only\nreceipt=receipt.json\n" + (kind === "pr" ? `for receipt in receipt.json; do\n${block}\necho normal-publication\ndone\n` : block);
    const result = spawnSync("bash", ["-c", shell], { cwd: directory, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: directory, PROBE_DIR: directory, PROBE_KIND: kind, PROBE_STATUS: status ?? "", PROBE_ERROR: error, VERIFY_REPLAY_BOUNDARIES: String(enabled), VERIFY_PR_QUALIFICATION_BOUNDARY: String(enabled) } });
    const calls = existsSync(join(directory, "calls.json")) ? JSON.parse(readFileSync(join(directory, "calls.json"), "utf8")) : [];
    if (!enabled || !qualified) { assert.equal(result.status, 0, result.stderr); assert.equal(calls.length, 0); }
    else if (status || error !== (kind === "pr" ? "invalid_request" : "conflict")) assert.notEqual(result.status, 0);
    else if (kind === "pr") { assert.equal(result.status, 0, result.stderr); assert.deepEqual(calls, [receipt]); assert.ok(!result.stdout.includes("normal-publication")); }
    else if (kind === "target") { assert.equal(result.status, 0, result.stderr); assert.deepEqual(calls, [target]); }
    else {
      assert.equal(result.status, 0, result.stderr);
      const altered = structuredClone(receipt);
      altered.controls.good.resultDigest = `sha256:${"0".repeat(64)}`;
      assert.deepEqual(calls, [receipt, altered]);
    }
    assert.ok(!result.stdout.includes("synthetic-local-only"));
    checks.push({ kind, enabled, qualified, status: status ?? "expected", error });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
run("target");
run("qualification");
run("target", { enabled: false });
run("qualification", { enabled: false });
run("qualification", { qualified: false });
run("target", { status: "200" });
run("qualification", { status: "403" });
run("target", { error: "unauthorized" });
run("qualification", { error: "unauthorized" });
run("pr", { error: "invalid_request" });
run("pr", { enabled: false, error: "invalid_request" });
run("pr", { status: "200", error: "invalid_request" });
run("pr", { status: "403", error: "invalid_request" });
run("pr", { error: "forbidden" });
console.log(JSON.stringify({ check: "publisher-replay-shell", passed: checks.length, networkRequests: 0, serverValidation: false }));
