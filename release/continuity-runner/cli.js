#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { announceRun, assertPackageReady, buildQualificationRequest, createOffboardingExport, qualificationSummary, readAvailablePackages, readPackages, scaffoldPackage, runAllPackages, runManifestEntries, runOne, runTarget, runTamperControls, sealPackageDraft, selectManifestEntries, validateExecutionManifest, } from "./index.js";
// Standard output and standard error are pipes in GitHub Actions, so writes to
// them complete asynchronously. Exiting immediately after a write can drop it.
// Every exit path drains both channels first: the closed result on stdout and
// the explanation a person reads on stderr must both survive.
const drainOutput = async () => {
    await new Promise((resolve) => {
        process.stdout.write("", () => resolve());
    });
    await new Promise((resolve) => {
        process.stderr.write("", () => resolve());
    });
};
const [command, packagePath, auxiliary, outputPath] = process.argv.slice(2);
if (!command || !packagePath) {
    console.error("usage: continuity-runner <scaffold|seal|validate-package|qualify|qualification-request|run-one|run-one-target|run-all|run-manifest-target|exercise|offboarding> <package-or-draft-path> [control|manifest|metadata] [output]");
    await drainOutput();
    process.exit(2);
}
try {
    if (command === "scaffold") {
        const result = await scaffoldPackage(packagePath, auxiliary);
        console.log(JSON.stringify({ scaffolded: true, ...result }));
        await drainOutput();
        process.exit(0);
    }
    if (command === "seal") {
        if (!auxiliary)
            throw new Error("seal requires a creation-only output path");
        const draft = JSON.parse(await readFile(packagePath, "utf8"));
        const sealed = await sealPackageDraft(draft);
        await writeFile(auxiliary, JSON.stringify(sealed, null, 2) + "\n", {
            encoding: "utf8",
            flag: "wx",
        });
        console.log(JSON.stringify({
            sealed: true,
            packageDigest: sealed.packageDigest,
            output: auxiliary,
        }));
        await drainOutput();
        process.exit(0);
    }
    if (command === "qualification-request") {
        if (!auxiliary)
            throw new Error("qualification-request requires metadata JSON");
        const packages = await readPackages(packagePath);
        if (packages.length !== 1)
            throw new Error("qualification-request requires exactly one sealed package");
        const metadata = JSON.parse(await readFile(auxiliary, "utf8"));
        const request = await buildQualificationRequest(packages[0], metadata);
        const serialized = JSON.stringify(request, null, 2) + "\n";
        if (outputPath)
            await writeFile(outputPath, serialized, { encoding: "utf8", flag: "wx" });
        else
            console.log(serialized);
        await drainOutput();
        process.exit(0);
    }
    if (command === "run-manifest" || command === "run-manifest-target") {
        if (!auxiliary)
            throw new Error("run-manifest-target requires a frozen manifest path");
        const manifest = validateExecutionManifest(JSON.parse(await readFile(auxiliary, "utf8")));
        const mode = command === "run-manifest-target" ? "target" : "exercise";
        // One missing, re-sealed, or unreadable package must not blank the catalog.
        // Read what is readable, resolve every manifest entry on its own, and let
        // the envelopes that are fine still run.
        const { packages: available, rejected } = await readAvailablePackages(packagePath);
        const selections = selectManifestEntries(available, manifest);
        const results = await runManifestEntries(selections, mode);
        await announceRun(selections, results, rejected);
        console.log(JSON.stringify({
            schemaVersion: "continuity-run-output/v1",
            mode,
            sourceSha: results[0]?.sourceSha ?? null,
            results,
        }));
    }
    else {
        const packages = await readPackages(packagePath);
        if (packages.length === 0)
            throw new Error("no acceptance packages found");
        const pkg = packages[0];
        if (command === "validate" || command === "validate-package") {
            console.log(JSON.stringify({ valid: true, packageDigest: pkg.packageDigest }));
        }
        else if (command === "run-one-target") {
            console.log(JSON.stringify(await runTarget(pkg)));
        }
        else if (command === "run-one") {
            if (!["good", "bad", "refactor"].includes(auxiliary ?? ""))
                throw new Error("run-one requires good, bad, or refactor");
            console.log(JSON.stringify(await runOne(pkg, auxiliary)));
        }
        else if (command === "run-all" ||
            command === "exercise" ||
            command === "baseline" ||
            command === "qualify") {
            const qualificationMode = command === "baseline" || command === "qualify";
            if (qualificationMode)
                for (const item of packages)
                    await assertPackageReady(item);
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
            const selections = packages.map((item) => ({
                kind: "package",
                envelopeId: item.envelope.id,
                package: item,
            }));
            await announceRun(selections, results);
            if ((command === "baseline" || command === "qualify") &&
                (!qualification || !qualification.allControlsPassed || !qualification.tamperDetected))
                throw new Error("baseline requires passing good, bad, refactor, and actual material-tamper controls");
            console.log(JSON.stringify(output));
        }
        else if (command === "offboarding") {
            const exported = createOffboardingExport(pkg);
            const destination = auxiliary ?? outputPath;
            if (destination)
                await writeFile(destination, JSON.stringify(exported, null, 2) + "\n", "utf8");
            else
                console.log(JSON.stringify(exported));
        }
        else
            throw new Error(`unknown command: ${command}`);
    }
}
catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await drainOutput();
    process.exit(1);
}
