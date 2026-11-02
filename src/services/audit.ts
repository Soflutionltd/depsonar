import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ─── Security Audit Scanner ────────────────────────────────────────────

export interface VulnerabilityInfo {
  package: string;
  severity: "critical" | "high" | "moderate" | "low" | "info";
  title: string;
  url: string;
  fixVersion: string | null;
  currentVersion: string | null;
}

export interface AuditResult {
  project: string;
  language: string;
  vulnerabilities: VulnerabilityInfo[];
  totalVulnerabilities: number;
  critical: number;
  high: number;
  moderate: number;
  low: number;
  auditCommand: string;
  error: string | null;
}

function cmd(command: string, cwd: string, timeout = 30_000): string | null {
  try {
    return execSync(command, {
      encoding: "utf-8",
      timeout,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e: any) {
    // npm audit exits non-zero when vulns found
    if (e.stdout) return e.stdout.toString().trim();
    if (e.stderr) return e.stderr.toString().trim();
    return null;
  }
}

function cmdExists(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: "pipe" });
    return true;
  } catch { return false; }
}

// ─── NPM / PNPM Audit ─────────────────────────────────────────────────

function auditNode(projectPath: string, projectName: string): AuditResult {
  // Detect PM
  const pm = existsSync(join(projectPath, "pnpm-lock.yaml")) ? "pnpm"
    : existsSync(join(projectPath, "yarn.lock")) ? "yarn"
    : existsSync(join(projectPath, "bun.lockb")) || existsSync(join(projectPath, "bun.lock")) ? "bun"
    : "npm";

  const auditCmd = pm === "pnpm" ? "pnpm audit --json"
    : pm === "yarn" ? "yarn audit --json"
    : "npm audit --json";

  if (pm === "yarn" || pm === "bun") {
    return emptyResult(projectName, "node", auditCmd, `Audit output of ${pm} is not supported yet: run it by hand.`);
  }

  const raw = cmd(auditCmd, projectPath, 60_000);
  if (!raw) return emptyResult(projectName, "node", auditCmd, "Audit command failed or timed out.");
  return parseNodeAudit(raw, projectName, auditCmd);
}

/**
 * Reads `npm audit --json` (v7+: `vulnerabilities`, one entry per package) and
 * `pnpm audit --json` (`advisories`, one entry per advisory, no `total`).
 * Counts come from `metadata.vulnerabilities`, as each tool reports them.
 */
export function parseNodeAudit(raw: string, projectName: string, auditCmd: string): AuditResult {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyResult(projectName, "node", auditCmd, `Failed to parse audit output: ${raw.slice(0, 200)}`);
  }

  if (data.error) {
    const message = typeof data.error === "object" ? data.error.summary || data.error.code : String(data.error);
    return emptyResult(projectName, "node", auditCmd, `Audit failed: ${message}`);
  }
  const meta = data.metadata?.vulnerabilities;
  if (!meta || (!data.vulnerabilities && !data.advisories)) {
    return emptyResult(projectName, "node", auditCmd, "Unrecognized audit output (no vulnerabilities, advisories or metadata).");
  }

  const vulns: VulnerabilityInfo[] = [];
  for (const [pkg, info] of Object.entries(data.vulnerabilities ?? {}) as any[]) {
    const via = Array.isArray(info.via) ? info.via : [];
    const advisory = via.find((v: any) => typeof v === "object" && v.title);
    vulns.push({
      package: pkg,
      severity: info.severity || "moderate",
      title: advisory?.title || `Vulnerability in ${pkg}`,
      url: advisory?.url || "",
      fixVersion: typeof info.fixAvailable === "object" ? info.fixAvailable?.version || null : info.fixAvailable ? "available" : null,
      currentVersion: info.range || null,
    });
  }
  for (const advisory of Object.values(data.advisories ?? {}) as any[]) {
    vulns.push({
      package: advisory.module_name,
      severity: advisory.severity || "moderate",
      title: advisory.title || `Vulnerability in ${advisory.module_name}`,
      url: advisory.url || "",
      fixVersion: advisory.patched_versions || null,
      currentVersion: advisory.findings?.[0]?.version || null,
    });
  }

  const count = (key: "critical" | "high" | "moderate" | "low" | "info"): number => Number(meta[key] ?? 0);
  return {
    project: projectName,
    language: "node",
    vulnerabilities: vulns,
    totalVulnerabilities: Number(meta.total ?? count("critical") + count("high") + count("moderate") + count("low") + count("info")),
    critical: count("critical"),
    high: count("high"),
    moderate: count("moderate"),
    low: count("low"),
    auditCommand: auditCmd,
    error: null,
  };
}

// ─── Cargo Audit (Rust) ────────────────────────────────────────────────

function auditRust(projectPath: string, projectName: string): AuditResult {
  if (!cmdExists("cargo-audit") && !cmdExists("cargo")) {
    return emptyResult(projectName, "rust", "cargo audit", "cargo-audit not installed. Run: cargo install cargo-audit");
  }

  const raw = cmd("cargo audit --json", projectPath, 60_000);
  if (!raw) return emptyResult(projectName, "rust", "cargo audit --json", "Audit command failed.");

  try {
    const data = JSON.parse(raw);
    const vulns: VulnerabilityInfo[] = (data.vulnerabilities?.list || []).map((v: any) => ({
      package: v.advisory?.package || "unknown",
      severity: mapRustSeverity(v.advisory?.cvss),
      title: v.advisory?.title || "Unknown vulnerability",
      url: v.advisory?.url || "",
      fixVersion: v.versions?.patched?.[0] || null,
      currentVersion: v.package?.version || null,
    }));

    return {
      project: projectName,
      language: "rust",
      vulnerabilities: vulns,
      totalVulnerabilities: vulns.length,
      critical: vulns.filter(v => v.severity === "critical").length,
      high: vulns.filter(v => v.severity === "high").length,
      moderate: vulns.filter(v => v.severity === "moderate").length,
      low: vulns.filter(v => v.severity === "low").length,
      auditCommand: "cargo audit --json",
      error: null,
    };
  } catch {
    return emptyResult(projectName, "rust", "cargo audit --json", "Failed to parse audit output.");
  }
}

function mapRustSeverity(cvss: any): VulnerabilityInfo["severity"] {
  if (!cvss) return "moderate";
  const score = typeof cvss === "number" ? cvss : parseFloat(cvss);
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "moderate";
  return "low";
}

// ─── Pip Audit (Python) ────────────────────────────────────────────────

function auditPython(projectPath: string, projectName: string): AuditResult {
  if (!cmdExists("pip-audit") && !cmdExists("pip3")) {
    return emptyResult(projectName, "python", "pip-audit", "pip-audit not installed. Run: pip install pip-audit");
  }

  // Try pip-audit first (better), then pip audit
  const auditTool = cmdExists("pip-audit") ? "pip-audit" : "pip3";
  const auditCmd = auditTool === "pip-audit" 
    ? "pip-audit --format=json -r requirements.txt" 
    : "pip3 audit --format=json";

  const raw = cmd(auditCmd, projectPath, 60_000);
  if (!raw) return emptyResult(projectName, "python", auditCmd, null); // No issues or tool not available

  try {
    const data = JSON.parse(raw);
    const vulns: VulnerabilityInfo[] = (Array.isArray(data) ? data : data.dependencies || [])
      .filter((d: any) => d.vulns && d.vulns.length > 0)
      .flatMap((d: any) => d.vulns.map((v: any) => ({
        package: d.name,
        severity: v.fix_versions?.length ? "high" : "moderate",
        title: v.id || "Vulnerability",
        url: v.aliases?.[0] ? `https://nvd.nist.gov/vuln/detail/${v.aliases[0]}` : "",
        fixVersion: v.fix_versions?.[0] || null,
        currentVersion: d.version || null,
      })));

    return {
      project: projectName,
      language: "python",
      vulnerabilities: vulns,
      totalVulnerabilities: vulns.length,
      critical: vulns.filter(v => v.severity === "critical").length,
      high: vulns.filter(v => v.severity === "high").length,
      moderate: vulns.filter(v => v.severity === "moderate").length,
      low: vulns.filter(v => v.severity === "low").length,
      auditCommand: auditCmd,
      error: null,
    };
  } catch {
    return emptyResult(projectName, "python", auditCmd, "Failed to parse audit output.");
  }
}

// ─── Composer Audit (PHP) ──────────────────────────────────────────────

function auditPhp(projectPath: string, projectName: string): AuditResult {
  if (!cmdExists("composer")) return emptyResult(projectName, "php", "composer audit", "Composer not installed.");

  const raw = cmd("composer audit --format=json", projectPath, 60_000);
  if (!raw) return emptyResult(projectName, "php", "composer audit --format=json", null);

  try {
    const data = JSON.parse(raw);
    const vulns: VulnerabilityInfo[] = [];

    for (const [pkg, advisories] of Object.entries(data.advisories || {}) as any[]) {
      for (const adv of (Array.isArray(advisories) ? advisories : [])) {
        vulns.push({
          package: pkg,
          severity: "high",
          title: adv.title || adv.advisoryId || "Vulnerability",
          url: adv.link || "",
          fixVersion: null,
          currentVersion: adv.affectedVersions || null,
        });
      }
    }

    return {
      project: projectName, language: "php", vulnerabilities: vulns,
      totalVulnerabilities: vulns.length,
      critical: 0, high: vulns.length, moderate: 0, low: 0,
      auditCommand: "composer audit --format=json", error: null,
    };
  } catch {
    return emptyResult(projectName, "php", "composer audit", "Failed to parse.");
  }
}

// ─── Go Vulncheck ──────────────────────────────────────────────────────

function auditGo(projectPath: string, projectName: string): AuditResult {
  if (!cmdExists("govulncheck")) {
    return emptyResult(projectName, "go", "govulncheck", "govulncheck not installed. Run: go install golang.org/x/vuln/cmd/govulncheck@latest");
  }

  const raw = cmd("govulncheck -json ./...", projectPath, 60_000);
  if (!raw) return emptyResult(projectName, "go", "govulncheck -json ./...", null);

  try {
    // govulncheck outputs JSON lines
    const vulns: VulnerabilityInfo[] = [];
    for (const line of raw.split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (entry.vulnerability) {
          const v = entry.vulnerability;
          vulns.push({
            package: v.modules?.[0]?.module || "unknown",
            severity: "high",
            title: v.id || "Vulnerability",
            url: `https://pkg.go.dev/vuln/${v.id}`,
            fixVersion: v.modules?.[0]?.fixed_version || null,
            currentVersion: v.modules?.[0]?.found_version || null,
          });
        }
      } catch { /* skip invalid lines */ }
    }

    return {
      project: projectName, language: "go", vulnerabilities: vulns,
      totalVulnerabilities: vulns.length,
      critical: 0, high: vulns.length, moderate: 0, low: 0,
      auditCommand: "govulncheck -json ./...", error: null,
    };
  } catch {
    return emptyResult(projectName, "go", "govulncheck", "Failed to parse.");
  }
}

// ─── Helpers & Exports ─────────────────────────────────────────────────

function emptyResult(project: string, language: string, auditCommand: string, error: string | null): AuditResult {
  return {
    project, language, vulnerabilities: [], totalVulnerabilities: 0,
    critical: 0, high: 0, moderate: 0, low: 0, auditCommand, error,
  };
}

export function auditProject(projectPath: string, projectName: string, language: string): AuditResult {
  switch (language) {
    case "node": return auditNode(projectPath, projectName);
    case "rust": return auditRust(projectPath, projectName);
    case "python": return auditPython(projectPath, projectName);
    case "php": return auditPhp(projectPath, projectName);
    case "go": return auditGo(projectPath, projectName);
    default: return emptyResult(projectName, language, "N/A", `No audit tool available for ${language}.`);
  }
}

export function auditAllProjects(
  projects: Array<{ name: string; path: string; language: string }>
): AuditResult[] {
  return projects
    .map((p) => auditProject(p.path, p.name, p.language))
    .filter((r) => r.totalVulnerabilities > 0 || r.error);
}
