import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const expectedDir = join(root, "release/continuity-runner");
const temporaryRoot = await mkdtemp(join(tmpdir(), "balladeer-attestor-runner-"));
const generatedDir = join(temporaryRoot, "continuity-runner");
const releaseFiles = ["cli.js", "index.js"];

try {
  const tsc = join(root, "node_modules/typescript/bin/tsc");
  const build = spawnSync(
    process.execPath,
    [
      tsc,
      "-p",
      join(root, "packages/continuity-runner/tsconfig.release.json"),
      "--outDir",
      generatedDir,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (build.status !== 0) {
    process.stderr.write(build.stderr || build.stdout || "release runner compilation failed\n");
    process.exit(1);
  }

  const committed = (await readdir(expectedDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const generated = (await readdir(generatedDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(committed) !== JSON.stringify(releaseFiles))
    throw new Error(`committed runner inventory differs: ${committed.join(", ")}`);
  if (JSON.stringify(generated) !== JSON.stringify(releaseFiles))
    throw new Error(`generated runner inventory differs: ${generated.join(", ")}`);

  for (const file of releaseFiles) {
    const [expected, actual] = await Promise.all([
      readFile(join(expectedDir, file)),
      readFile(join(generatedDir, file)),
    ]);
    if (!expected.equals(actual))
      throw new Error(`${relative(root, join(expectedDir, file))} is not reproducible from source`);
  }
  console.log(`prebuilt runner is reproducible (${releaseFiles.length} files)`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
