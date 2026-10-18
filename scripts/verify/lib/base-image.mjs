/**
 * Base-image preflight for the container verification flow.
 *
 * `docker/Dockerfile` builds from `node:22-bookworm-slim`, and that base image is
 * the only external artefact the build needs (the `web/` devDependencies come from
 * the committed npm cache, offline). A build is *allowed* to pull it implicitly:
 * Docker's default policy is `missing`, so a pruned image store or a fresh
 * environment silently re-downloads ~80 MB before the gate can start. On a host
 * whose daemon proxy or DNS is broken that pull hangs, and a healthy tree reads as
 * a red gate.
 *
 * The policy here makes the network explicit instead:
 *
 *   1. inspect the local image store — present means the run never touches the
 *      network;
 *   2. absent means exactly one explicit `docker pull`, announced as such;
 *   3. `MEERKAT_TASKPANEL_OFFLINE=1` forbids even that one pull, and the failure
 *      tells the reader how to seed the local store from a tarball;
 *   4. the build itself carries the builder's no-pull flag (`--pull=false` on the
 *      legacy builder, `--pull=never` on BuildKit), so a race between the preflight
 *      and the build cannot become an implicit pull either.
 *
 * Everything is exported as a pure function plus one injectable `run`, matching
 * `docker-plan.mjs`: no spawn happens here, so the policy is testable without a
 * Docker daemon.
 */

import { imageInspectArgs, pullArgs } from "./docker-plan.mjs";

/**
 * The external base images a Dockerfile's `FROM` instructions reference.
 *
 * Stage aliases (`FROM webbuild`) and `scratch` are not images, and a
 * `--platform=` flag is not part of the reference. Duplicates collapse: the
 * Dockerfile names the same Node base twice, once per stage, and preflighting it
 * twice would be noise.
 *
 * @param {string} text Dockerfile contents
 * @returns {string[]} references in first-seen order
 */
export function parseBaseImages(text) {
  /** @type {string[]} */
  const refs = [];
  const aliases = new Set();

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^FROM\s+(.+)$/i.exec(line);
    if (!match) continue;

    // `FROM node:22-bookworm-slim # pin later` — the comment is not part of the ref.
    const parts = match[1].replace(/\s+#.*$/, "").trim().split(/\s+/);

    // Leading `--platform=…` (and any future `--flag`) precedes the image.
    let index = 0;
    while (index < parts.length && parts[index].startsWith("--")) index += 1;

    const ref = parts[index];
    const asIndex = parts.findIndex((part) => part.toUpperCase() === "AS");
    if (asIndex !== -1 && parts[asIndex + 1]) aliases.add(parts[asIndex + 1].toLowerCase());

    if (!ref || ref.toLowerCase() === "scratch") continue;
    if (aliases.has(ref.toLowerCase())) continue;
    if (!refs.includes(ref)) refs.push(ref);
  }

  return refs;
}

/**
 * The `--pull` form this builder accepts.
 *
 * The flag changed type silently: the legacy builder takes a boolean
 * (`--pull=false`; `never` is a parse error), while BuildKit — the default from
 * Docker 23 on — takes a policy string (`always|missing|never`; `false` is a parse
 * error). The `docker build --help` line is the discriminator: BuildKit prints the
 * type as `--pull string`, the legacy builder prints a bare `--pull`.
 *
 * An unrecognised help text falls back to the legacy form, which the preflight
 * still backs up: if the flag were wrong the build fails immediately on argument
 * parsing and nothing is pulled.
 *
 * @param {string} helpText output of `docker build --help`
 * @returns {string}
 */
export function pullFlagFor(helpText) {
  return /--pull\s+string\b/.test(helpText) ? "--pull=never" : "--pull=false";
}

/**
 * Ask the daemon's builder which no-pull flag it understands.
 *
 * @param {{run: (command: string, args: string[]) => object}} options
 * @returns {string|null} `null` when the probe itself could not run — the caller
 *   then leaves `--pull` out and relies on the preflight
 */
export function resolvePullFlag({ run }) {
  const probe = run("docker", ["build", "--help"]);
  const help = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
  if (probe.error || probe.status !== 0 || !help.trim()) return null;
  return pullFlagFor(help);
}

/** Last few lines of a failed command's output, for a one-line failure detail. */
function tail(text, lines = 6) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "";
  return trimmed.split("\n").slice(-lines).join("\n");
}

/**
 * Ensure every base image the Dockerfile names is in the local image store.
 *
 * @param {{
 *   run: (command: string, args: string[]) => object,
 *   dockerfileText: string,
 *   offline?: boolean,
 * }} options
 * @returns {{ok: boolean, lines: string[], error?: string}}
 */
export function preflightBaseImages({ run, dockerfileText, offline = false }) {
  /** @type {string[]} */
  const lines = [];
  const refs = parseBaseImages(dockerfileText);

  for (const ref of refs) {
    const inspected = run("docker", imageInspectArgs(ref));
    const id = (inspected.stdout ?? "").trim();

    if (!inspected.error && inspected.status === 0 && id) {
      lines.push(`cached   ${ref} (${id.slice(0, 19)})`);
      continue;
    }

    if (offline) {
      const tarball = `${ref.replace(/[/:]/g, "-")}.tar`;
      return {
        ok: false,
        lines,
        error:
          `base image not cached: ${ref}\n` +
          `  MEERKAT_TASKPANEL_OFFLINE=1 forbids the one-time pull.\n` +
          `  Seed the local image store from a networked host, then re-run:\n` +
          `    docker pull ${ref} && docker save ${ref} -o ${tarball}\n` +
          `    docker load -i ${tarball}`,
      };
    }

    lines.push(`missing  ${ref} — pulling once (the only network access in this run)`);
    const pulled = run("docker", pullArgs(ref));
    if (pulled.error || pulled.status !== 0) {
      return {
        ok: false,
        lines,
        error: `docker pull ${ref} failed:\n${tail(pulled.stderr ?? pulled.error?.message ?? "")}`,
      };
    }
    lines.push(`pulled   ${ref}`);
  }

  return { ok: true, lines };
}
