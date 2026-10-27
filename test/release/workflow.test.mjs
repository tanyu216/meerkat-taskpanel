/**
 * Static assertions on `.github/workflows/release.yml`.
 *
 * The repository is zero-dependency and offline and ships no YAML parser, so a
 * workflow cannot be *run* here — these read the shipped file as text, the same
 * footing as `test/docker.test.mjs`. What they pin is the publish pipeline's
 * safety contract:
 *
 *   - the trigger is a `v*` tag push or an explicit dispatch; a dispatch defaults
 *     to a dry run;
 *   - the five stages are ordered `verify → build → publish → smoke → release`,
 *     so a red gate stops everything after it;
 *   - the only write scopes are `id-token` in `publish` and `contents` in
 *     `release`, and there is **no registry token** anywhere (trusted publishing
 *     over OIDC);
 *   - `publish` uploads the tarball `build` produced, never a second `npm pack`;
 *   - the GitHub Release is public (no `--draft`), has a closed asset list, and
 *     the job asserts `isDraft=false`;
 *   - the SBOM is required, and `verify` runs the authoritative container suite.
 *
 * Run with: node --test
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW = ".github/workflows/release.yml";

/** Read a repository-relative file as UTF-8 text. */
function read(relPath) {
  return readFile(join(ROOT, relPath), "utf8");
}

/**
 * Drop whole-line YAML/shell comments. Prose about a thing (`no `npm publish` step`)
 * is not the thing, so every absence assertion reads this view, never the raw file.
 */
function code(text) {
  return text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
}

/** The lines of one `  <name>:` job, up to the next job or EOF. */
function jobBlock(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^ {2}[a-z][\w-]*:$/.test(lines[end])) end += 1;
  return lines.slice(start, end).join("\n");
}

/** The step block (`- name:` / `- uses:` up to the next step) containing `needle`. */
function stepBlock(text, needle) {
  const lines = text.split("\n");
  const hit = lines.findIndex((line) => line.includes(needle));
  if (hit === -1) return null;

  let start = hit;
  while (start > 0 && !/^\s*- (name|uses): /.test(lines[start])) start -= 1;
  let end = start + 1;
  while (end < lines.length && !/^\s*- (name|uses): /.test(lines[end])) end += 1;
  return lines.slice(start, end).join("\n");
}

describe("release.yml: the trigger", () => {
  it("runs on a v* tag push or a dispatch that defaults to a dry run", async () => {
    const text = code(await read(WORKFLOW));
    assert.match(text, /^on:\n {2}push:\n {4}tags: \["v\*"\]\n {2}workflow_dispatch:/m);
    assert.match(text, /tag:\n(?:.*\n)*?\s+required: false/);
    assert.match(text, /dry_run:\n(?:.*\n)*?\s+default: true/);
    assert.match(text, /^concurrency:\n {2}group: release$/m);
  });

  it("gives every job a timeout", async () => {
    const text = code(await read(WORKFLOW));
    for (const name of ["verify", "build", "publish", "smoke", "release"]) {
      const job = jobBlock(text, name);
      assert.ok(job, `expected the ${name} job`);
      assert.match(job, /timeout-minutes:/, `the ${name} job must be bounded`);
    }
  });
});

describe("release.yml: the stage order", () => {
  it("chains verify → build → publish → smoke → release", async () => {
    const text = code(await read(WORKFLOW));
    assert.match(jobBlock(text, "build"), /needs: verify/);
    assert.match(jobBlock(text, "publish"), /needs: build/);
    assert.match(jobBlock(text, "smoke"), /needs: \[build, publish\]/);
    assert.match(jobBlock(text, "release"), /needs: \[build, smoke\]/);
  });

  it("skips smoke and release on a dry run, but still builds and dry-publishes", async () => {
    const text = code(await read(WORKFLOW));
    assert.match(jobBlock(text, "smoke"), /if: \$\{\{ inputs\.dry_run != true \}\}/);
    assert.match(jobBlock(text, "release"), /if: \$\{\{ inputs\.dry_run != true \}\}/);
    assert.match(jobBlock(text, "publish"), /npm publish "\$tarball" --dry-run/);
  });
});

describe("release.yml: the gates", () => {
  it("runs the tag gate and the authoritative container suite in verify", async () => {
    const verify = jobBlock(code(await read(WORKFLOW)), "verify");
    assert.match(verify, /tag-version\.mjs "\$TAG" --on-main/);
    assert.match(verify, /changelog\.mjs "\$TAG" --strict/);
    assert.match(verify, /route-request\.mjs/);
    assert.match(verify, /paths\.mjs/);
    assert.match(verify, /signposts\.mjs/);
    assert.match(verify, /npm run verify:docker/, "the tag gate is the whole suite, not a subset");
  });

  it("checks the tarball's version before the SBOM is attached", async () => {
    const build = jobBlock(code(await read(WORKFLOW)), "build");
    assert.match(build, /web-dist\.mjs --require=bundle/);
    assert.match(build, /pack-manifest\.mjs "\$TARBALL" --expected-version "\$VERSION"/);
    assert.match(
      build,
      /tarball-install\.mjs --tarball "\$TARBALL" --expected-version "\$VERSION"/,
      "the exact tarball is installed and booted before it is uploaded",
    );
    assert.ok(build.indexOf("pack-manifest.mjs") < build.indexOf("anchore/sbom-action"));
  });

  it("makes the SBOM a required artifact of the same build", async () => {
    const body = code(await read(WORKFLOW));
    assert.match(body, /anchore\/sbom-action/);
    assert.match(body, /format: spdx-json/);
    assert.match(body, /output-file: sbom\.spdx\.json/);
    assert.match(body, /test -s sbom\.spdx\.json/);
    assert.doesNotMatch(body, /continue-on-error/);
    const upload = stepBlock(body, "actions/upload-artifact");
    assert.match(upload, /release-artifacts/);
    assert.match(upload, /sbom\.spdx\.json/);
    assert.match(upload, /if-no-files-found: error/);
  });
});

describe("release.yml: the publish", () => {
  it("uses OIDC trusted publishing and holds no registry token", async () => {
    const body = code(await read(WORKFLOW));
    const publish = jobBlock(body, "publish");

    assert.match(publish, /id-token: write/);
    assert.equal((body.match(/id-token: write/g) ?? []).length, 1, "only the publish job may mint the OIDC token");
    assert.match(publish, /node-version: "24"/, "npm >= 11.5.1 is required for trusted publishing");

    assert.doesNotMatch(body, /secrets\./, "no secret is used by the release pipeline");
    assert.doesNotMatch(body, /registry-url/, "setup-node must not write an auth placeholder");
    assert.doesNotMatch(body, /^\s+(NODE_AUTH_TOKEN|NPM_TOKEN):/m, "the token names may only appear in the guard");
    assert.match(publish, /if \[ -n "\$\{NODE_AUTH_TOKEN:-\}" \]/, "a stray token must fail the job");
  });

  it("publishes the built tarball, not a second pack", async () => {
    const publish = jobBlock(code(await read(WORKFLOW)), "publish");
    assert.match(publish, /actions\/download-artifact/);
    assert.match(publish, /tarball="\$\(ls pkg\/\*\.tgz\)"/);
    assert.match(publish, /npm publish "\$tarball" --provenance --access public/);
    assert.doesNotMatch(publish, /npm pack/, "packing happens once, in build");
  });

  it("waits for the exact version and its provenance before smoke", async () => {
    const publish = jobBlock(code(await read(WORKFLOW)), "publish");
    assert.match(publish, /npm view "meerkat-taskpanel@\$\{VERSION\}" version/);
    assert.match(publish, /dist\.attestations/);
    assert.match(publish, /sleep/, "the registry is polled, not assumed");
  });
});

describe("release.yml: the smoke", () => {
  it("installs the published version outside the repository", async () => {
    const smoke = jobBlock(code(await read(WORKFLOW)), "smoke");
    assert.match(smoke, /node:24-bookworm-slim/);
    assert.match(smoke, /npm install --no-audit --no-fund "meerkat-taskpanel@\$\{VERSION\}"/);
    assert.match(smoke, /published-smoke\.mjs/);
    assert.doesNotMatch(smoke, /npm install \./, "the repository's own tree must not satisfy the install");
  });
});

describe("release.yml: the GitHub Release", () => {
  it("publishes a public release with a closed asset list", async () => {
    const release = jobBlock(code(await read(WORKFLOW)), "release");
    assert.match(release, /contents: write/);
    assert.match(release, /node scripts\/release\/release-notes\.mjs/);
    assert.match(release, /gh release create "\$tag"/);
    assert.doesNotMatch(release, /--draft(?!=)/, "the release must not be created as a draft");
    assert.match(release, /isDraft/, "the job asserts the result is public");
    // The closed asset list, spelled out: the tarball variable and the SBOM path,
    // nothing globbed out of the workspace.
    assert.match(
      release,
      /gh release create "\$tag" \\\n\s+"\$tarball" \\\n\s+artifacts\/sbom\.spdx\.json/,
      "assets are exactly the tarball and the SBOM, in that order",
    );
  });
});
