#!/usr/bin/env node
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  announceMerge,
  announceRun,
  assertPackageReady,
  buildQualificationRequest,
  createOffboardingExport,
  mergeShardOutputs,
  qualificationSummary,
  readAvailablePackages,
  readPackages,
  reportLocalTargetExit,
  runOutputDocument,
  scaffoldPackage,
  runAllPackages,
  runManifestEntries,
  runOne,
  runTarget,
  runTamperControls,
  sealPackageDraft,
  selectManifestEntries,
  shardSelections,
  validateExecutionManifest,
  type Control,
  type ManifestEntrySelection,
  type ScaffoldPromiseFacts,
  type ShardCoordinates,
} from "./index.js";

// Standard output and standard error are pipes in GitHub Actions, so writes to
// them complete asynchronously. Exiting immediately after a write can drop it.
// Every exit path drains both channels first: the closed result on stdout and
// the explanation a person reads on stderr must both survive.
const drainOutput = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    process.stdout.write("", () => resolve());
  });
  await new Promise<void>((resolve) => {
    process.stderr.write("", () => resolve());
  });
};

/**
 * Options are read before positionals, so every existing invocation keeps the
 * exact argument order it had. `--shard`/`--shards` are the only ones, and both
 * default to the unsharded run.
 */
const options = new Map<string, string>();
const positional: string[] = [];
{
  const argv = process.argv.slice(2);
  for (let cursor = 0; cursor < argv.length; cursor += 1) {
    const token = argv[cursor]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const separator = token.indexOf("=");
    if (separator === -1) {
      options.set(token.slice(2), argv[cursor + 1] ?? "");
      cursor += 1;
    } else options.set(token.slice(2, separator), token.slice(separator + 1));
  }
}

const wholeNumber = (name: string, fallback: number): number => {
  const raw = options.get(name);
  if (raw === undefined) return fallback;
  if (!/^[0-9]{1,6}$/.test(raw)) throw new Error(`--${name} must be a whole number`);
  return Number(raw);
};

const [command, packagePath, auxiliary, outputPath] = positional;
if (!command || !packagePath) {
  console.error(
    "usage: continuity-runner <scaffold|seal|validate-package|qualify|qualification-request|run-one|run-one-target|run-all|run-manifest-target|merge-shard-results|exercise|offboarding> <package-or-draft-path> [control|manifest|metadata|promise-id] [output|promise-facts.json] [--shard N --shards K]\n" +
      '  scaffold .continuity <promise-id> [promise-facts.json]  promise-facts.json is {"claim":..., "owner":..., "promiseUrl":...}, read off the promise\n' +
      "  run-one-target exits 0 when the behavior holds, 1 when it is refuted, 3 when the check could not run, 4 when custody is invalid\n" +
      "  run-manifest-target --shard N --shards K runs one shard of the fan-out; the merge joins them\n" +
      "  merge-shard-results <manifest> <shard-results-dir> [output]  joins every shard in promise order",
  );
  await drainOutput();
  process.exit(2);
}
try {
  if (command === "scaffold") {
    // The optional fourth argument is a small JSON file holding the three facts
    // that are not derivable from the promise id: the sentence the owner
    // approved, the owner's name, and the promise's page. An agent reads them
    // off `get_promise` and writes them here, and the starter comes out already
    // able to name what it protects. Left out, the starter carries placeholders
    // and `seal` refuses them.
    const facts = outputPath
      ? ((JSON.parse(await readFile(outputPath, "utf8")) as ScaffoldPromiseFacts) ?? undefined)
      : undefined;
    if (facts !== undefined) {
      const named = ["claim", "owner", "promiseUrl"] as const;
      const missing = named.filter((key) => typeof facts[key] !== "string" || !facts[key].trim());
      if (missing.length > 0)
        throw new Error(
          `scaffold facts file must carry ${named.join(", ")} as non-empty strings; missing or empty: ${missing.join(", ")}`,
        );
    }
    const result = await scaffoldPackage(packagePath, auxiliary, process.cwd(), facts);
    console.log(JSON.stringify({ scaffolded: true, ...result }));
    await drainOutput();
    process.exit(0);
  }
  if (command === "seal") {
    if (!auxiliary) throw new Error("seal requires a creation-only output path");
    const draft = JSON.parse(await readFile(packagePath, "utf8")) as unknown;
    const sealed = await sealPackageDraft(draft);
    await writeFile(auxiliary, JSON.stringify(sealed, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
    console.log(
      JSON.stringify({
        sealed: true,
        packageDigest: sealed.packageDigest,
        output: auxiliary,
      }),
    );
    await drainOutput();
    process.exit(0);
  }
  if (command === "qualification-request") {
    if (!auxiliary) throw new Error("qualification-request requires metadata JSON");
    const packages = await readPackages(packagePath);
    if (packages.length !== 1)
      throw new Error("qualification-request requires exactly one sealed package");
    const metadata = JSON.parse(await readFile(auxiliary, "utf8")) as unknown;
    const request = await buildQualificationRequest(packages[0]!, metadata);
    const serialized = JSON.stringify(request, null, 2) + "\n";
    if (outputPath) await writeFile(outputPath, serialized, { encoding: "utf8", flag: "wx" });
    else console.log(serialized);
    await drainOutput();
    process.exit(0);
  }
  if (command === "merge-shard-results") {
    // The merge sees closed result documents and the frozen manifest. It never
    // sees customer source, and it holds no token: it runs in its own job so
    // that the publisher's no-checkout boundary is unchanged.
    if (!auxiliary) throw new Error("merge-shard-results requires a shard results directory");
    const manifest = validateExecutionManifest(
      JSON.parse(await readFile(packagePath, "utf8")) as unknown,
    );
    const sourceSha = process.env.BALLADEER_SOURCE_SHA ?? process.env.GITHUB_SHA ?? "";
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        // Symbolic links are not followed: an artifact is a directory of files.
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
      }
    };
    await walk(auxiliary);
    files.sort();
    // The artifacts are read one at a time, in sorted path order. The public
    // release gate reads "verifier controls and packages execute serially" off
    // this source as a plain text scan, so no concurrent promise combinator may
    // appear in this file or in `index.ts`. Nothing is owed to concurrency
    // here: the merge reads a handful of small closed result documents, and the
    // sequential read also makes a failure deterministic, because the first
    // unreadable artifact in path order is the one that is reported.
    const documents: unknown[] = [];
    for (const path of files) documents.push(JSON.parse(await readFile(path, "utf8")) as unknown);
    const report = mergeShardOutputs(manifest, documents, sourceSha);
    await announceMerge(report);
    const merged = {
      schemaVersion: "continuity-run-output/v1",
      mode: "target" as const,
      manifestDigest: report.manifestDigest,
      shard: { index: 0, count: 1 },
      sourceSha,
      results: report.results,
    };
    const serialized = JSON.stringify(merged);
    if (outputPath) await writeFile(outputPath, serialized + "\n", "utf8");
    else console.log(serialized);
  } else if (command === "run-manifest" || command === "run-manifest-target") {
    if (!auxiliary) throw new Error("run-manifest-target requires a frozen manifest path");
    const manifest = validateExecutionManifest(
      JSON.parse(await readFile(auxiliary, "utf8")) as unknown,
    );
    const mode = command === "run-manifest-target" ? "target" : "exercise";
    const shard: ShardCoordinates = {
      index: wholeNumber("shard", 0),
      count: wholeNumber("shards", 1),
    };
    // One missing, re-sealed, or unreadable package must not blank the catalog.
    // Read what is readable, resolve every manifest entry on its own, and let
    // the promises that are fine still run. The whole manifest is resolved and
    // digest-checked here; only which entries THIS job executes is sharded.
    const { packages: available, rejected } = await readAvailablePackages(packagePath);
    const selections = shardSelections(selectManifestEntries(available, manifest), shard);
    const results = await runManifestEntries(selections, mode);
    await announceRun(selections, results, rejected);
    console.log(JSON.stringify(runOutputDocument(mode, manifest, shard, results)));
  } else {
    const packages = await readPackages(packagePath);
    if (packages.length === 0) throw new Error("no acceptance packages found");
    const pkg = packages[0]!;
    if (command === "validate" || command === "validate-package") {
      console.log(JSON.stringify({ valid: true, packageDigest: pkg.packageDigest }));
    } else if (command === "run-one-target") {
      // The one command a coder runs on their own machine to ask "does this
      // promise still hold?". It says the same four things the protected CI
      // check says, and it exits non-zero when the answer is no: a local run
      // that printed a refutation and exited 0 let an `&&` chain, a pre-commit
      // hook, and an editor's task runner all report success over a broken
      // behavior.
      const result = await runTarget(pkg);
      console.log(JSON.stringify(result));
      await announceRun([{ kind: "package", promiseId: pkg.promise.id, package: pkg }], [result]);
      const status = reportLocalTargetExit(result);
      await drainOutput();
      process.exit(status);
    } else if (command === "run-one") {
      if (!["good", "bad", "refactor"].includes(auxiliary ?? ""))
        throw new Error("run-one requires good, bad, or refactor");
      console.log(JSON.stringify(await runOne(pkg, auxiliary as Control)));
    } else if (
      command === "run-all" ||
      command === "exercise" ||
      command === "baseline" ||
      command === "qualify"
    ) {
      const qualificationMode = command === "baseline" || command === "qualify";
      if (qualificationMode) for (const item of packages) await assertPackageReady(item);
      const results = await runAllPackages(packages);
      const tamperControls = qualificationMode ? await runTamperControls(packages) : [];
      const qualification = qualificationMode
        ? qualificationSummary(packages, results, tamperControls)
        : undefined;
      const output = {
        schemaVersion: "continuity-run-output/v1",
        mode: qualificationMode ? "qualification" : "exercise",
        sourceSha: results[0]?.sourceSha ?? null,
        results,
        ...(qualification === undefined ? {} : { qualification }),
      };
      // Explain the run in the operator's own log before a failing control ends
      // it, so a red check is never wordless.
      const selections: ManifestEntrySelection[] = packages.map((item) => ({
        kind: "package",
        promiseId: item.promise.id,
        package: item,
      }));
      await announceRun(selections, results);
      // A control that could not decide never qualifies a binding. It is named
      // separately from a control that decided the wrong way, because a crashed
      // known-bad control says nothing at all about whether the verifier can
      // tell a broken behavior from a working one.
      if (qualificationMode && qualification && qualification.undecidedControls > 0)
        throw new Error(
          "qualification requires every control to produce a verdict; at least one control errored, timed out, or was canceled, so this package cannot be qualified",
        );
      if (
        (command === "baseline" || command === "qualify") &&
        (!qualification || !qualification.allControlsDiscriminated || !qualification.tamperDetected)
      )
        throw new Error(
          "qualification requires the good control to pass, the known-bad control to be refuted, the refactor control to pass, and an actual material-tamper control to be detected",
        );
      console.log(JSON.stringify(output));
    } else if (command === "offboarding") {
      const exported = createOffboardingExport(pkg);
      const destination = auxiliary ?? outputPath;
      if (destination)
        await writeFile(destination, JSON.stringify(exported, null, 2) + "\n", "utf8");
      else console.log(JSON.stringify(exported));
    } else throw new Error(`unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await drainOutput();
  process.exit(1);
}
