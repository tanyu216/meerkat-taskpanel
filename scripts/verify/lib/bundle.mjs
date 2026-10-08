/**
 * Offline plugin-bundle and marketplace inspector.
 *
 * The container image ships Node and the repository only — none of the four host CLIs
 * (`claude`, `codex`, `openclaw`, `pi`) and no network to install them (see
 * ARCHITECTURE §9.1: verification runs isolated, offline). So the container cannot ask
 * the OpenClaw CLI "do you recognize this bundle?".
 *
 * This module answers that question *offline* by reproducing the detection contract the
 * hosts actually apply, with the rules transcribed from the OpenClaw CLI that ships on
 * the developer host (`openclaw 2026.9.8`, `dist/bundle-manifest-*.mjs`
 * `detectBundleManifestFormat` / `loadBundleManifest`, documented in
 * `docs/plugins/bundles.md` § "Detection precedence"). The host-CLI run is the
 * supplementary cross-check (`scripts/verify/host-cli.mjs`); this is what CI and the
 * container assert on.
 *
 * Detection precedence (OpenClaw):
 *   1. `openclaw.plugin.json`, or a `package.json` carrying `openclaw.extensions`
 *      -> a NATIVE plugin (skill-only packs cannot use this: see docs/install.md)
 *   2. `.codex-plugin/` | `.cursor-plugin/` | `.claude-plugin/` markers -> that bundle
 *   3. root `plugin.json` declaring the Agent Plugins `$schema` -> an Agent bundle
 *   4. the default Claude layout (`skills/`, `commands/`, `agents/`, `.mcp.json`, …)
 *      -> a manifestless Claude bundle
 *
 * Everything here is synchronous and filesystem-only: no processes, no network.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { readFrontmatterField } from "./frontmatter.mjs";

/** Marker file for a Codex bundle (root-relative). */
export const CODEX_MANIFEST = ".codex-plugin/plugin.json";
/** Marker file for a Cursor bundle (root-relative). */
export const CURSOR_MANIFEST = ".cursor-plugin/plugin.json";
/** Marker file for a Claude bundle (root-relative). */
export const CLAUDE_MANIFEST = ".claude-plugin/plugin.json";
/** Root-level Agent Plugins manifest. */
export const AGENT_MANIFEST = "plugin.json";
/** Native OpenClaw plugin manifest (root level, no dot-directory). */
export const NATIVE_MANIFEST = "openclaw.plugin.json";
/** npm package manifest — Pi's distribution unit (and native OpenClaw's, with extensions). */
export const PACKAGE_MANIFEST = "package.json";

/** Agent Plugins `$schema` that promotes a root `plugin.json` to an Agent bundle. */
export const AGENT_BUNDLE_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

/** Native OpenClaw entry-point candidates; their presence marks a native (non-bundle) package. */
export const PLUGIN_ENTRY_CANDIDATES = ["index.ts", "index.js", "index.mjs", "index.cjs"];

/** Default skill/content roots for a manifestless Claude layout. */
export const CLAUDE_DEFAULT_ROOTS = [
  "skills",
  "commands",
  "agents",
  "output-styles",
  ".mcp.json",
  ".lsp.json",
  "settings.json",
];

/**
 * What each shipped host bundle is expected to look like. `dir` is repository-relative.
 * `openclawFormat` is what OpenClaw's detector reports for that directory.
 *
 * @type {Record<string, {dir: string, manifest: string, openclawKind: string, openclawFormat: string}>}
 */
export const HOST_BUNDLES = {
  claude: {
    dir: "plugins/claude",
    manifest: CLAUDE_MANIFEST,
    openclawKind: "bundle",
    openclawFormat: "claude",
  },
  codex: {
    dir: "plugins/codex",
    manifest: CODEX_MANIFEST,
    openclawKind: "bundle",
    openclawFormat: "codex",
  },
  openclaw: {
    dir: "plugins/openclaw",
    manifest: NATIVE_MANIFEST,
    openclawKind: "native",
    openclawFormat: "native",
  },
  pi: {
    dir: "plugins/pi",
    manifest: PACKAGE_MANIFEST,
    // Pi's own unit is an npm package, but OpenClaw sees the ships-a-`skills/`-dir
    // layout and classifies it as a manifestless Claude bundle. Both are true.
    openclawKind: "bundle",
    openclawFormat: "claude",
  },
};

/** Absolute path under `rootDir` with `/`-separated inputs. */
function at(rootDir, rel) {
  return join(rootDir, ...rel.split("/"));
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Read and parse a JSON file; returns `{ok, value, error}` without throwing. */
function readJson(path) {
  if (!isFile(path)) return { ok: false, value: null, error: `not found: ${path}` };
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, value: null, error: `unreadable: ${err.message}` };
  }
  try {
    return { ok: true, value: JSON.parse(raw), error: null };
  } catch (err) {
    return { ok: false, value: null, error: `invalid JSON: ${err.message}` };
  }
}

/**
 * Normalize a manifest path field that may be a single string or a list of strings
 * (OpenClaw's `normalizeBundlePathList`).
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizePathList(value) {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const out = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().replace(/^\.\//, "").replace(/\/+$/, "");
    if (trimmed !== "" && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Detect the kind and bundle format of a plugin directory, mirroring OpenClaw's
 * `detectBundleManifestFormat`.
 *
 * @param {string} rootDir
 * @returns {{kind: "bundle"|"native"|"package"|"unknown", format: string|null, manifestPath: string|null}}
 */
export function detectBundle(rootDir) {
  const pkg = readJson(at(rootDir, PACKAGE_MANIFEST));
  const hasExtensions =
    pkg.ok && pkg.value && typeof pkg.value.openclaw === "object" && pkg.value.openclaw !== null;

  // 1. Native: an explicit manifest, or a package that declares runtime extensions.
  if (hasExtensions && existsSync(at(rootDir, NATIVE_MANIFEST))) {
    return { kind: "native", format: "native", manifestPath: NATIVE_MANIFEST };
  }

  // 2. Client-specific bundle markers (OpenClaw checks codex/cursor/claude in order).
  for (const [manifest, format] of [
    [CODEX_MANIFEST, "codex"],
    [CURSOR_MANIFEST, "cursor"],
    [CLAUDE_MANIFEST, "claude"],
  ]) {
    if (existsSync(at(rootDir, manifest))) return { kind: "bundle", format, manifestPath: manifest };
  }

  if (existsSync(at(rootDir, NATIVE_MANIFEST))) {
    return { kind: "native", format: "native", manifestPath: NATIVE_MANIFEST };
  }

  // 3. Root `plugin.json` — only an Agent bundle when it declares the standard schema.
  const agent = readJson(at(rootDir, AGENT_MANIFEST));
  if (agent.ok && agent.value?.$schema === AGENT_BUNDLE_SCHEMA) {
    return { kind: "bundle", format: "agent", manifestPath: AGENT_MANIFEST };
  }

  if (PLUGIN_ENTRY_CANDIDATES.some((c) => existsSync(at(rootDir, c)))) {
    return { kind: "native", format: "native", manifestPath: null };
  }

  // 4. Default Claude layout.
  if (CLAUDE_DEFAULT_ROOTS.some((c) => existsSync(at(rootDir, c)))) {
    return { kind: "bundle", format: "claude", manifestPath: null };
  }

  if (pkg.ok) return { kind: "package", format: "package", manifestPath: PACKAGE_MANIFEST };

  return { kind: "unknown", format: null, manifestPath: null };
}

/**
 * Resolve the skill roots a bundle declares (OpenClaw's `resolveClaudeComponents` /
 * `resolveCodexComponentDirs` / `resolveAgentSkillDirs`): declared paths are additive to
 * the format's defaults, and a default only counts when the directory exists.
 *
 * @param {string} rootDir
 * @param {string} format bundle format from {@link detectBundle}
 * @param {Record<string, unknown>} raw parsed manifest (or `{}` when manifestless)
 * @returns {string[]} repository-relative dirs, first-match order preserved
 */
export function resolveSkillRoots(rootDir, format, raw = {}) {
  const declared = normalizePathList(raw?.skills);
  const pick = (candidates) => {
    const out = [...declared];
    for (const c of candidates) if (isDir(at(rootDir, c)) && !out.includes(c)) out.push(c);
    return out;
  };

  switch (format) {
    case "codex":
      return pick(["skills"]);
    case "cursor":
      return pick(["skills", ".cursor/commands"]);
    case "agent":
      return pick(["skills"]);
    case "claude":
      return pick(["skills", "commands", "agents", "output-styles"]);
    case "native":
    case "package":
      // Native/Pi packs may still ship a skills/ tree; it is informational here.
      return pick(["skills"]);
    default:
      return declared;
  }
}

/**
 * A skill root may hold `SKILL.md` directly or one directory per skill. Return the
 * immediate children that actually contain a `SKILL.md` (OpenClaw loads only those).
 *
 * @param {string} rootDir
 * @param {string} root rel dir
 * @param {string} entry file name that marks a skill
 * @returns {Array<{dir: string, entry: string, name: string|null}>}
 */
export function findSkills(rootDir, root, entry = "SKILL.md") {
  const abs = at(rootDir, root);
  if (!isDir(abs)) return [];

  const found = [];
  const record = (dir, fileRel) => {
    let name = null;
    try {
      name = readFrontmatterField(readFileSync(at(rootDir, fileRel), "utf8"), "name");
    } catch {
      name = null;
    }
    found.push({ dir, entry: fileRel, name });
  };

  if (isFile(at(rootDir, `${root}/${entry}`))) {
    record(root, `${root}/${entry}`);
    return found;
  }

  let children = [];
  try {
    children = readdirSync(abs, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const child of children) {
    if (!child.isDirectory()) continue;
    const rel = `${root}/${child.name}`;
    if (isFile(at(rootDir, `${rel}/${entry}`))) record(rel, `${rel}/${entry}`);
  }

  return found;
}

/**
 * Full inspection of one plugin directory: detection + resolved, loadable skills.
 *
 * @param {string} rootDir
 * @returns {{
 *   rootDir: string,
 *   kind: string,
 *   format: string|null,
 *   manifestPath: string|null,
 *   manifest: Record<string, unknown>|null,
 *   manifestError: string|null,
 *   skillRoots: string[],
 *   skills: Array<{dir: string, entry: string, name: string|null}>,
 * }}
 */
export function inspectBundle(rootDir) {
  const { kind, format, manifestPath } = detectBundle(rootDir);

  let manifest = null;
  let manifestError = null;
  if (manifestPath) {
    const parsed = readJson(at(rootDir, manifestPath));
    if (parsed.ok) manifest = parsed.value;
    else manifestError = parsed.error;
  }

  const skillRoots = format ? resolveSkillRoots(rootDir, format, manifest ?? {}) : [];
  const skills = skillRoots.flatMap((root) => findSkills(rootDir, root));

  return { rootDir, kind, format, manifestPath, manifest, manifestError, skillRoots, skills };
}

/**
 * Parse the repository-root Claude marketplace (`.claude-plugin/marketplace.json`) and
 * resolve each entry's relative `source` to an on-disk bundle.
 *
 * Claude's marketplace schema: `name`, `owner`, `metadata`, `plugins[]`, where each entry
 * is `{name, source, description?}` and `source` is a path relative to the marketplace
 * root.
 *
 * @param {string} rootDir repository root
 * @returns {{
 *   ok: boolean,
 *   path: string,
 *   name: string|null,
 *   error: string|null,
 *   entries: Array<{name: string|null, source: string|null, dir: string|null, exists: boolean, format: string|null, skills: number, error: string|null}>
 * }}
 */
export function parseMarketplace(rootDir) {
  const rel = ".claude-plugin/marketplace.json";
  const path = at(rootDir, rel);
  const parsed = readJson(path);

  const result = { ok: false, path: rel, name: null, error: null, entries: [] };
  if (!parsed.ok) {
    result.error = parsed.error;
    return result;
  }

  const data = parsed.value;
  if (!data || typeof data !== "object") {
    result.error = "marketplace manifest must be an object";
    return result;
  }
  result.name = typeof data.name === "string" ? data.name : null;

  const plugins = Array.isArray(data.plugins) ? data.plugins : null;
  if (!plugins || plugins.length === 0) {
    result.error = "marketplace manifest must declare a non-empty `plugins` array";
    return result;
  }

  for (const plugin of plugins) {
    const name = typeof plugin?.name === "string" ? plugin.name : null;
    const source = typeof plugin?.source === "string" ? plugin.source : null;
    const entry = { name, source, dir: null, exists: false, format: null, skills: 0, error: null };

    if (!source || !source.startsWith(".")) {
      entry.error = source ? `source must be a relative path, got ${JSON.stringify(source)}` : "missing `source`";
    } else {
      const dir = source.replace(/^\.\//, "").replace(/\/+$/, "");
      entry.dir = dir;
      entry.exists = isDir(at(rootDir, dir));
      if (entry.exists) {
        const bundle = inspectBundle(at(rootDir, dir));
        entry.format = bundle.format;
        entry.skills = bundle.skills.length;
        if (!bundle.format) entry.error = "source directory is not a recognized bundle";
        else if (bundle.skills.length === 0) entry.error = "bundle exposes no loadable skill";
      } else {
        entry.error = `source directory not found: ${dir}`;
      }
    }

    result.entries.push(entry);
  }

  result.ok = result.error === null && result.entries.every((e) => e.error === null);
  return result;
}
