// Run with: npm test (builds first, then tests dist/)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCargoDryRun, checkOutdated, isMajorUpdate } from "../dist/services/project.js";
import { getLockedNodePackages } from "../dist/services/osv.js";
import { formatCve, formatLiveCve, formatScanSummary } from "../dist/services/formatter.js";

function folder(files) {
  const root = mkdtempSync(join(tmpdir(), "depsonar-sources-"));
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  return root;
}

test("parseCargoDryRun: compatible updates and newer incompatible versions, index lines ignored", () => {
  const output = [
    "    Updating crates.io index",
    "     Locking 3 packages to latest compatible versions",
    "    Updating tokio v1.47.0 -> v1.48.0",
    "    Updating hyper v1.6.0 -> v1.7.0 (available: v2.0.0)",
    "   Unchanged reqwest v0.12.28 (available: v0.13.5)",
    "    Removing async-io v2.6.0",
    "      Adding new-dep v0.1.0",
    "warning: not updating lockfile due to dry run",
  ].join("\n");

  assert.deepEqual(parseCargoDryRun(output), {
    tokio: { current: "1.47.0", wanted: "1.48.0", latest: "1.48.0" },
    hyper: { current: "1.6.0", wanted: "1.7.0", latest: "2.0.0" },
    reqwest: { current: "0.12.28", wanted: "0.12.28", latest: "0.13.5" },
  });
});

test("parseCargoDryRun: two versions of the same crate stay distinct", () => {
  const output = "    Updating syn v1.0.109 -> v1.0.110\n    Updating syn v2.0.90 -> v2.0.91\n";
  assert.deepEqual(Object.keys(parseCargoDryRun(output)), ["syn", "syn@2.0.90"]);
});

test("isMajorUpdate: semver, the minor number is breaking below 1.0.0", () => {
  assert.equal(isMajorUpdate("4.18.2", "4.19.0"), false);
  assert.equal(isMajorUpdate("5.19.0", "6.3.0"), true);
  assert.equal(isMajorUpdate("^1.2.0", "2.0.0"), true);
  assert.equal(isMajorUpdate("0.12.28", "0.13.5"), true);
  assert.equal(isMajorUpdate("0.103.16", "0.103.17"), false);
  assert.equal(isMajorUpdate("0.9.0", "1.0.0"), true);
  assert.equal(isMajorUpdate("not installed", "1.32.2"), false);
});

test("checkOutdated: a failing check is reported, never shown as up to date", (t) => {
  const root = folder({ "package.json": "{\"name\":\"broken\"}" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = checkOutdated(root, { name: "broken", path: root, language: "node", packageManager: "no-such-pm", framework: "Node.js", dependencies: {}, devDependencies: {} });
  assert.deepEqual(result.outdated, {});
  assert.match(result.error, /no-such-pm outdated failed/);
});

test("getLockedNodePackages: package-lock lists transitive packages, links and the root are skipped", (t) => {
  const root = folder({
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "app", version: "1.0.0" },
        "node_modules/@modelcontextprotocol/sdk": { version: "1.20.0" },
        "node_modules/hono": { version: "4.6.0" },
        "node_modules/@modelcontextprotocol/sdk/node_modules/hono": { version: "4.5.0" },
        "node_modules/local-pkg": { link: true },
        "node_modules/aliased": { name: "real-name", version: "2.0.0" },
      },
    }),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(getLockedNodePackages(root), [
    { name: "@modelcontextprotocol/sdk", version: "1.20.0" },
    { name: "hono", version: "4.6.0" },
    { name: "hono", version: "4.5.0" },
    { name: "real-name", version: "2.0.0" },
  ]);
});

test("getLockedNodePackages: pnpm-lock packages section, scoped names and peer suffixes", (t) => {
  const root = folder({
    "pnpm-lock.yaml": [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      svelte:",
      "        version: 5.1.0",
      "packages:",
      "  svelte@5.1.0:",
      "    resolution: {integrity: sha512-x}",
      "  '@sveltejs/kit@2.8.0(svelte@5.1.0)':",
      "    resolution: {integrity: sha512-y}",
      "  /devalue@5.1.1:",
      "    resolution: {integrity: sha512-z}",
      "snapshots:",
      "  svelte@5.1.0: {}",
    ].join("\n"),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(getLockedNodePackages(root), [
    { name: "svelte", version: "5.1.0" },
    { name: "@sveltejs/kit", version: "2.8.0" },
    { name: "devalue", version: "5.1.1" },
  ]);
});

test("getLockedNodePackages: null without a lockfile", (t) => {
  const root = folder({ "package.json": "{}" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(getLockedNodePackages(root), null);
});

test("formatCve: an outdated built-in database is never reported as a clean result", () => {
  const output = formatCve([{ project: "app", affected: [] }], { total: 11, packages: ["svelte"], lastUpdate: "2026-01-15" });
  assert.doesNotMatch(output, /✅/);
  assert.match(output, /2026-01-15/);
  assert.match(output, /depsonar_live_cve/);
});

test("formatLiveCve: unmaintained crates are warnings, not vulnerabilities", () => {
  const output = formatLiveCve([{
    project: "crate",
    packagesQueried: 2,
    vulnerabilities: [
      { id: "GHSA-1", summary: "Body limit bypass", severity: "moderate", kind: "vulnerability", package: "hono", fixedVersion: "4.12.16", url: "u1" },
      { id: "RUSTSEC-1", summary: "`zvariant` is unmaintained", severity: "low", kind: "unmaintained", package: "zvariant", fixedVersion: null, url: "u2" },
    ],
  }]);
  assert.match(output, /Found \*\*1\*\* vulnerabilities and \*\*1\*\* warning/);
  assert.match(output, /warning: unmaintained, not a vulnerability/);
});

test("formatScanSummary: a failed check is not counted as up to date", () => {
  const output = formatScanSummary([
    { name: "ok", language: "node", framework: "Node.js", pm: "npm", fwVersion: null, outdatedCount: 0, hasMajor: false },
    { name: "broken", language: "rust", framework: "Rust", pm: "npm", fwVersion: null, outdatedCount: 0, hasMajor: false, error: "cargo is not installed" },
  ]);
  assert.match(output, /\*\*1\*\* up to date/);
  assert.match(output, /❌ check failed: cargo is not installed/);
});
