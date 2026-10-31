// Installs a matching better-auth + @better-auth/core pair for the compatibility matrix.
//
//   node .github/scripts/use-better-auth.mjs <spec>
//
// <spec> is an exact version (1.4.19), a range (~1.5) or a dist-tag (latest, beta).
// Ranges resolve to their highest published version. Both packages are pinned to the
// same exact version, since better-auth depends on a matching @better-auth/core.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const spec = process.argv[2];
if (!spec) {
  throw new Error("Usage: use-better-auth.mjs <version | range | dist-tag>");
}

// Run npm outside the project so its devEngines check doesn't apply.
const view = (pkg) => {
  const out = execFileSync("npm", ["view", `${pkg}@${spec}`, "version", "--json"], {
    cwd: tmpdir(),
    encoding: "utf8",
  }).trim();
  if (!out) throw new Error(`No published ${pkg} version matches '${spec}'.`);
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed.at(-1) : parsed;
};

const version = view("better-auth");
const coreVersion = view("@better-auth/core");
if (version !== coreVersion) {
  throw new Error(
    `'${spec}' resolves to better-auth@${version} but @better-auth/core@${coreVersion}.`,
  );
}

console.log(`Installing better-auth@${version} and @better-auth/core@${version} (from '${spec}').`);
execFileSync(
  "pnpm",
  ["add", "--save-dev", "--save-exact", `better-auth@${version}`, `@better-auth/core@${version}`],
  { stdio: "inherit" },
);

for (const pkg of ["better-auth", "@better-auth/core"]) {
  const installed = JSON.parse(
    readFileSync(new URL(`../../node_modules/${pkg}/package.json`, import.meta.url), "utf8"),
  ).version;
  if (installed !== version) {
    throw new Error(`Expected ${pkg}@${version}, found ${installed}.`);
  }
}
