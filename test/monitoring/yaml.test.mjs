/**
 * Tests for `monitoring/lib/yaml.mjs` — the small YAML reader used to validate the
 * declarative artefacts (`monitoring/prometheus/*.yml`, `monitoring/otel/collector.yml`,
 * `docker/docker-compose.observability.yml`).
 *
 * The reader exists because the project has no dependencies and no `js-yaml`. It parses
 * the *subset* those files use and refuses — loudly, with a line number — anything it
 * does not implement, so it can never silently mis-read a document. Each refusal is
 * asserted below, because a parser that guesses is worse than one that stops.
 */

import assert from "node:assert/strict";
import test, { describe, it } from "node:test";

import { MonitoringError } from "../../monitoring/lib/errors.mjs";
import { parseYaml } from "../../monitoring/lib/yaml.mjs";

/** Parse `text`, assert it failed with `code`, and return the error. */
function errorOf(text, code) {
  try {
    parseYaml(text);
  } catch (error) {
    assert.ok(error instanceof MonitoringError, `expected a MonitoringError, got ${error}`);
    assert.equal(error.code, code, `for input:\n${text}`);
    return error;
  }
  throw new assert.AssertionError({ message: `expected a ${code} for:\n${text}` });
}

describe("yaml — scalars, maps and sequences", () => {
  it("parses an empty document as null", () => {
    assert.equal(parseYaml(""), null);
    assert.equal(parseYaml("# only a comment\n\n  \n"), null);
  });

  it("parses nested maps and typed scalars", () => {
    const doc = parseYaml(
      [
        "name: task-panel",
        "port: 9105",
        "ratio: 0.001",
        "enabled: true",
        "disabled: false",
        "missing: ~",
        "empty:",
        'quoted: "a: b"',
        "single: 'it''s'",
        "url: http://127.0.0.1:9105/metrics",
        "nested:",
        "  a: 1",
        "  deeper:",
        "    b: two",
      ].join("\n"),
    );
    assert.deepEqual(doc, {
      name: "task-panel",
      port: 9105,
      ratio: 0.001,
      enabled: true,
      disabled: false,
      missing: null,
      empty: null,
      quoted: "a: b",
      single: "it's",
      url: "http://127.0.0.1:9105/metrics",
      nested: { a: 1, deeper: { b: "two" } },
    });
  });

  it("parses block sequences, and sequences of maps with nested sequences", () => {
    const doc = parseYaml(
      [
        "rule_files:",
        "  - /etc/prometheus/rules/task-panel.rules.yml",
        "scrape_configs:",
        "  - job_name: task-panel",
        "    static_configs:",
        "      - targets:",
        "          - taskd:9527",
        "          - monitoring:9105",
        "        labels:",
        "          job: task-panel",
        "  - job_name: prometheus",
        "scrape_interval: 15s",
      ].join("\n"),
    );
    assert.deepEqual(doc, {
      rule_files: ["/etc/prometheus/rules/task-panel.rules.yml"],
      scrape_configs: [
        {
          job_name: "task-panel",
          static_configs: [{ targets: ["taskd:9527", "monitoring:9105"], labels: { job: "task-panel" } }],
        },
        { job_name: "prometheus" },
      ],
      scrape_interval: "15s",
    });
  });

  it("parses flow sequences and flow maps, including nesting", () => {
    const doc = parseYaml('a: [1, "two", three]\nb: {k: v, n: 2}\nc: []\nd: {}\ne: [{x: 1}, [2]]\n');
    assert.deepEqual(doc, {
      a: [1, "two", "three"],
      b: { k: "v", n: 2 },
      c: [],
      d: {},
      e: [{ x: 1 }, [2]],
    });
  });

  it("parses block scalars with clip and strip chomping", () => {
    const doc = parseYaml(["clip: |", "  line1", "  line2", "strip: |-", "  line1", "  line2", "after: 1"].join("\n"));
    assert.deepEqual(doc, { clip: "line1\nline2\n", strip: "line1\nline2", after: 1 });
  });

  it("preserves blank lines and relative indentation inside a block scalar", () => {
    const doc = parseYaml("expr: |\n  a\n\n    b\nnext: 1\n");
    assert.equal(doc.expr, "a\n\n  b\n");
    assert.equal(doc.next, 1);
  });

  it("strips comments outside quotes but keeps # inside a quoted scalar or a word", () => {
    const doc = parseYaml(['a: 1 # trailing', '"b#c": "x # y"', "# whole line", "plain: a#b"].join("\n"));
    assert.deepEqual(doc, { a: 1, "b#c": "x # y", plain: "a#b" });
  });

  it("treats a sequence item's inline map as the start of the item", () => {
    const doc = parseYaml(["alerts:", "  - alert: Foo", "    expr: up == 0", "  - alert: Bar", "    for: 5m"].join("\n"));
    assert.deepEqual(doc, {
      alerts: [
        { alert: "Foo", expr: "up == 0" },
        { alert: "Bar", for: "5m" },
      ],
    });
  });
});

describe("yaml — refusals", () => {
  it("refuses the YAML features it does not implement", () => {
    for (const text of ["a: &anchor 1\n", "a: *ref\n", "a: !tag 1\n", "expr: >\n  a\n", "---\na: 1\n", "a: 1\n...\n"]) {
      errorOf(text, "UNSUPPORTED_YAML");
    }
  });

  it("refuses malformed input, carrying the offending line number", () => {
    const tab = errorOf("a: 1\n\tb: 2\n", "YAML_PARSE_ERROR");
    assert.equal(tab.line, 2);

    const unclosedQuote = errorOf('a: "unterminated\n', "YAML_PARSE_ERROR");
    assert.equal(unclosedQuote.line, 1);

    const unclosedFlow = errorOf("a: [1, 2\n", "YAML_PARSE_ERROR");
    assert.equal(unclosedFlow.line, 1);

    const badIndent = errorOf("a: 1\n  b: 2\n", "YAML_PARSE_ERROR");
    assert.equal(badIndent.line, 2);

    errorOf("a: 1\n- b\n", "YAML_PARSE_ERROR");
    errorOf("a 1\n", "YAML_PARSE_ERROR");
    errorOf("root:\n    a: 1\n  b: 2\n", "YAML_PARSE_ERROR");
  });
});
