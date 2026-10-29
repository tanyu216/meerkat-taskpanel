# Security policy

## Supported versions

Security fixes land on the latest released minor line. At the time of writing that is `0.1.x`.
An older minor is not patched; upgrade to the latest release.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private advisory form:

<https://github.com/tanyu216/meerkat-taskpanel/security/advisories/new>

Please include:

- what you can do that you should not be able to do, and the result;
- the version (`taskctl --version`), the platform and how the board runs (host, compose,
  `npx`);
- the smallest reproduction you have — a command, a request, or a short script.

This is a single-maintainer project, so the response is best effort rather than a contracted
SLA. You will get an acknowledgement, and a fix or a decision with its reason. A confirmed
issue is fixed in a new release; the advisory is published after the fix ships, and you are
credited unless you ask otherwise.

## Scope

In scope:

- the `taskd` request gate — the loopback rule, the CIDR allow-list and the token
  ([`docs/access.md`](docs/access.md));
- credential handling — where a token may live, whether it can leak into a log, a response or
  a URL;
- the `taskctl` CLI and the installers (`install.sh`, `npx meerkat-taskpanel`), including a
  path that writes outside its declared target;
- the shipped skills and plugin manifests;
- the container image and its build, including anything baked into it that should not be.

Out of scope, by design — these are recorded limitations, not defects:

- **The built board injects no token.** A browser reaching `taskd` from a non-loopback address
  is answered 401 for every request. That is the local-first trade-off, documented in
  `docs/access.md`.
- Anything that already requires the ability to read or write the data directory, run commands
  as the installing user, or modify the checkout.
- A denial of service you can only cause by already holding a valid token.
- Findings in a third-party dependency with no reachable call path — report them upstream; the
  repository's scans (`docs/tech-spec.md` § Security toolchain) track advisories.

## How the project scans itself

Dependency audit (`osv-scanner`, `npm audit`), secret scan (`gitleaks`), SAST (CodeQL) and an
SBOM (`syft`) run in CI. The policy — what blocks, how a waiver works, what the exit codes mean
— is [`docs/tech-spec.md`](docs/tech-spec.md) § Security toolchain.
