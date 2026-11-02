// Run with: npm test (builds first, then tests dist/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findProjectRoots, projectRootLabel } from "../dist/services/project.js";
import { parseNodeAudit } from "../dist/services/audit.js";

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "depsonar-roots-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const pkg = (name) => JSON.stringify({ name, version: "1.0.0" });

test("findProjectRoots: the folder itself, nested lockfiles, nothing under node_modules or dot folders", (t) => {
  const root = tree({
    "package.json": pkg("monorepo"),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "apps/web/package.json": pkg("web"),
    "apps/api/package.json": pkg("api"),
    "apps/api/package-lock.json": "{}",
    "node_modules/dep/package.json": pkg("dep"),
    "node_modules/dep/package-lock.json": "{}",
    ".svelte-kit/out/package.json": pkg("generated"),
    ".svelte-kit/out/package-lock.json": "{}",
    "a/b/c/d/e/package.json": pkg("too-deep"),
    "a/b/c/d/e/package-lock.json": "{}",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const lockfileRoots = findProjectRoots(root, "lockfile").map((r) => projectRootLabel(root, r));
  assert.deepEqual(lockfileRoots, ["monorepo (.)", "api (apps/api)"]);

  const manifestRoots = findProjectRoots(root, "manifest").map((r) => projectRootLabel(root, r));
  assert.deepEqual(manifestRoots, ["monorepo (.)", "api (apps/api)", "web (apps/web)"]);
});

test("findProjectRoots: an app one level down, without anything at the top", (t) => {
  const root = tree({ "app/package.json": pkg("site"), "app/package-lock.json": "{}", "notes/readme.md": "x" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(findProjectRoots(root, "lockfile").map((r) => projectRootLabel(root, r)), ["site (app)"]);
});

test("parseNodeAudit: pnpm format (advisories, no total)", () => {
  const raw = JSON.stringify({
    advisories: {
      1: { module_name: "tar", severity: "critical", title: "Path traversal", url: "https://x/1", patched_versions: ">=7.5.19", findings: [{ version: "7.4.3" }] },
      2: { module_name: "vite", severity: "high", title: "File read", url: "https://x/2", patched_versions: ">=6.4.4", findings: [{ version: "5.4.0" }] },
    },
    metadata: { vulnerabilities: { info: 0, low: 3, moderate: 2, high: 1, critical: 1 } },
  });
  const result = parseNodeAudit(raw, "web (.)", "pnpm audit --json");
  assert.equal(result.error, null);
  assert.equal(result.totalVulnerabilities, 7);
  assert.equal(result.critical, 1);
  assert.equal(result.high, 1);
  assert.equal(result.moderate, 2);
  assert.equal(result.low, 3);
  assert.deepEqual(result.vulnerabilities.map((v) => [v.package, v.severity, v.currentVersion]), [
    ["tar", "critical", "7.4.3"],
    ["vite", "high", "5.4.0"],
  ]);
});

test("parseNodeAudit: npm v7+ format (vulnerabilities, with total)", () => {
  const raw = JSON.stringify({
    vulnerabilities: {
      devalue: { severity: "high", via: [{ title: "Prototype pollution", url: "https://x/3" }], fixAvailable: true, range: "<=5.9.2" },
    },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
  });
  const result = parseNodeAudit(raw, "site (.)", "npm audit --json");
  assert.equal(result.error, null);
  assert.equal(result.totalVulnerabilities, 1);
  assert.equal(result.high, 1);
  assert.equal(result.vulnerabilities[0].title, "Prototype pollution");
});

test("parseNodeAudit: a clean project stays clean, without error", () => {
  const raw = JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } });
  const result = parseNodeAudit(raw, "site (.)", "npm audit --json");
  assert.equal(result.error, null);
  assert.equal(result.totalVulnerabilities, 0);
});

test("parseNodeAudit: failures are reported, never shown as clean", () => {
  assert.match(parseNodeAudit("not json", "x", "npm audit --json").error, /Failed to parse/);
  assert.match(
    parseNodeAudit(JSON.stringify({ error: { code: "ENOLOCK", summary: "This command requires an existing lockfile." } }), "x", "npm audit --json").error,
    /requires an existing lockfile/,
  );
  assert.match(parseNodeAudit(JSON.stringify({ something: "else" }), "x", "pnpm audit --json").error, /Unrecognized audit output/);
});
