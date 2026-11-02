// Audits real repositories at given commits and compares depsonar with npm / pnpm audit run directly.
// Usage: npm run build && node tests/integration.mjs <config.json>
// config.json: [{ "name": "app", "repo": "/path/to/repo", "commit": "abc1234", "expect": { "high": 3, "critical": 1 } }]
// "expect" is optional. Each commit is extracted with `git archive`: the repository is only read.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { findProjectRoots } from "../dist/services/project.js";
import { auditProject } from "../dist/services/audit.js";

const configPath = process.argv[2];
if (!configPath) {
  console.error("Usage: node tests/integration.mjs <config.json>");
  process.exit(2);
}
const cases = JSON.parse(readFileSync(configPath, "utf-8"));

// Independent reading of the audit tools' own counts.
function directCounts(dir) {
  const command = existsSync(join(dir, "pnpm-lock.yaml")) ? "pnpm" : "npm";
  let raw;
  try {
    raw = execFileSync(command, ["audit", "--json"], { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  } catch (e) {
    raw = e.stdout?.toString() ?? "";
  }
  const meta = JSON.parse(raw).metadata.vulnerabilities;
  return { high: meta.high ?? 0, critical: meta.critical ?? 0 };
}

let failures = 0;
for (const c of cases) {
  const dir = mkdtempSync(join(tmpdir(), `depsonar-it-${c.name}-`));
  try {
    execSync(`git -C "${c.repo}" archive ${c.commit} | tar -x -C "${dir}"`);
    const roots = findProjectRoots(dir, "lockfile");
    let high = 0;
    let critical = 0;
    for (const root of roots) {
      const label = relative(dir, root.path) || ".";
      const result = auditProject(root.path, label, root.language);
      if (result.error) {
        console.log(`  ${c.name} ${label}: ERROR ${result.error}`);
        failures++;
        continue;
      }
      const direct = directCounts(root.path);
      const same = direct.high === result.high && direct.critical === result.critical;
      if (!same) failures++;
      console.log(`  ${c.name} @ ${c.commit} ${label}: depsonar ${result.high} high / ${result.critical} critical, direct ${direct.high} / ${direct.critical} ${same ? "OK" : "DIFFERENT"}`);
      high += result.high;
      critical += result.critical;
    }
    if (roots.length === 0) {
      console.log(`  ${c.name}: no lockfile found`);
      failures++;
    }
    let verdict = "";
    if (c.expect) {
      const ok = c.expect.high === high && c.expect.critical === critical;
      if (!ok) failures++;
      verdict = ` | expected ${c.expect.high} / ${c.expect.critical} ${ok ? "OK" : "MISMATCH"}`;
    }
    console.log(`${c.name} @ ${c.commit}: ${roots.length} lockfile(s), ${high} high, ${critical} critical${verdict}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
