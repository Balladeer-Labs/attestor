#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { assertPackageReady, buildQualificationRequest, createOffboardingExport, qualificationSummary, readPackages, scaffoldPackage, runAllPackages, runOne, runTarget, runTargetPackages, runTamperControls, sealPackageDraft, selectManifestPackages, validateExecutionManifest, } from "./index.js";
const [command, packagePath, auxiliary, outputPath] = process.argv.slice(2);
if (!command || !packagePath) {
    console.error("usage: continuity-runner <scaffold|seal|validate-package|qualify|qualification-request|run-one|run-one-target|run-all|run-manifest-target|exercise|offboarding> <package-or-draft-path> [control|manifest|metadata] [output]");
    process.exit(2);
}
try {
    if (command === "scaffold") {
        const result = await scaffoldPackage(packagePath, auxiliary);
        console.log(JSON.stringify({ scaffolded: true, ...result }));
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
        process.exit(0);
    }
    let manifest;
    if (command === "run-manifest" || command === "run-manifest-target") {
        if (!auxiliary)
            throw new Error("run-manifest-target requires a frozen manifest path");
        manifest = validateExecutionManifest(JSON.parse(await readFile(auxiliary, "utf8")));
        if (manifest.envelopes.length === 0) {
            console.log(JSON.stringify({
                schemaVersion: "continuity-run-output/v1",
                mode: command === "run-manifest-target" ? "target" : "exercise",
                sourceSha: null,
                results: [],
            }));
            process.exit(0);
        }
    }
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
        command === "run-manifest" ||
        command === "run-manifest-target" ||
        command === "exercise" ||
        command === "baseline" ||
        command === "qualify") {
        const selected = command === "run-manifest" || command === "run-manifest-target"
            ? selectManifestPackages(packages, manifest)
            : packages;
        const targetMode = command === "run-manifest-target";
        const qualificationMode = command === "baseline" || command === "qualify";
        if (qualificationMode)
            for (const item of selected)
                await assertPackageReady(item);
        const results = targetMode ? await runTargetPackages(selected) : await runAllPackages(selected);
        const tamperControls = qualificationMode ? await runTamperControls(selected) : [];
        const qualification = qualificationMode
            ? qualificationSummary(selected, results, tamperControls)
            : undefined;
        const output = {
            schemaVersion: "continuity-run-output/v1",
            mode: targetMode ? "target" : qualificationMode ? "qualification" : "exercise",
            sourceSha: results[0]?.sourceSha ?? null,
            results,
            ...(qualification === undefined ? {} : { qualification }),
        };
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
catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
