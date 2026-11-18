import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ─── Live CVE Fetcher via osv.dev API ──────────────────────────────────
// Free, no auth, covers npm/PyPI/crates.io/Go/Packagist/RubyGems

export interface OsvVulnerability {
  id: string;
  summary: string;
  /** "unmaintained" and the other RustSec informational kinds are warnings, not vulnerabilities. */
  kind: "vulnerability" | "unmaintained" | "unsound" | "notice";
  severity: "critical" | "high" | "moderate" | "low";
  package: string;
  ecosystem: string;
  affectedRange: string;
  fixedVersion: string | null;
  url: string;
  published: string;
}

export interface LiveCveResult {
  project: string;
  vulnerabilities: OsvVulnerability[];
  packagesQueried: number;
  source: "osv.dev";
  queriedAt: string;
}

const ECOSYSTEM_MAP: Record<string, string> = {
  node: "npm",
  python: "PyPI",
  rust: "crates.io",
  go: "Go",
  php: "Packagist",
  ruby: "RubyGems",
  dart: "Pub",
};

function getInstalledPackages(projectPath: string, language: string): Array<{ name: string; version: string }> {
  const packages: Array<{ name: string; version: string }> = [];

  if (language === "node") {
    // The lockfile lists every installed package, transitive ones included: a flaw is most
    // often in a dependency of a dependency, which package.json never names.
    const locked = getLockedNodePackages(projectPath);
    if (locked) return locked;

    const pkgPath = join(projectPath, "package.json");
    if (!existsSync(pkgPath)) return [];
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const [name, spec] of Object.entries(allDeps)) {
        const nmPkg = join(projectPath, "node_modules", name, "package.json");
        if (existsSync(nmPkg)) {
          try {
            const nm = JSON.parse(readFileSync(nmPkg, "utf-8"));
            packages.push({ name, version: nm.version });
          } catch {
            packages.push({ name, version: String(spec).replace(/^[\^~>=<]+/, "") });
          }
        } else {
          packages.push({ name, version: String(spec).replace(/^[\^~>=<]+/, "") });
        }
      }
    } catch {}
  }

  if (language === "rust") {
    const lockPath = join(projectPath, "Cargo.lock");
    if (existsSync(lockPath)) {
      const content = readFileSync(lockPath, "utf-8");
      const regex = /\[\[package\]\]\nname = "(.+?)"\nversion = "(.+?)"/g;
      let match;
      while ((match = regex.exec(content))) {
        packages.push({ name: match[1], version: match[2] });
      }
    }
  }

  if (language === "python") {
    const reqPath = join(projectPath, "requirements.txt");
    if (existsSync(reqPath)) {
      const lines = readFileSync(reqPath, "utf-8").split("\n");
      for (const line of lines) {
        const m = line.trim().match(/^([a-zA-Z0-9_-]+)==(.+)/);
        if (m) packages.push({ name: m[1], version: m[2] });
      }
    }
  }

  if (language === "go") {
    const sumPath = join(projectPath, "go.sum");
    if (existsSync(sumPath)) {
      const seen = new Set<string>();
      const lines = readFileSync(sumPath, "utf-8").split("\n");
      for (const line of lines) {
        const m = line.match(/^(\S+)\s+v(\S+)/);
        if (m && !seen.has(m[1])) {
          seen.add(m[1]);
          packages.push({ name: m[1], version: m[2].replace(/\/go\.mod$/, "") });
        }
      }
    }
  }

  return packages;
}

/** Every name@version of package-lock.json (v2/v3) or pnpm-lock.yaml; null without a readable lockfile. */
export function getLockedNodePackages(projectPath: string): Array<{ name: string; version: string }> | null {
  const seen = new Map<string, { name: string; version: string }>();
  const add = (name: string, version: string) => {
    if (name && /^\d/.test(version)) seen.set(`${name}@${version}`, { name, version });
  };

  for (const file of ["package-lock.json", "npm-shrinkwrap.json"]) {
    const lockPath = join(projectPath, file);
    if (!existsSync(lockPath)) continue;
    const lock = JSON.parse(readFileSync(lockPath, "utf-8")) as {
      packages?: Record<string, { version?: string; link?: boolean; name?: string }>;
    };
    if (!lock.packages) continue;
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key.includes("node_modules/") || entry.link || !entry.version) continue;
      add(entry.name ?? key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length), entry.version);
    }
    return [...seen.values()];
  }

  const pnpmPath = join(projectPath, "pnpm-lock.yaml");
  if (existsSync(pnpmPath)) {
    let inPackages = false;
    for (const line of readFileSync(pnpmPath, "utf-8").split("\n")) {
      if (/^\S/.test(line)) inPackages = line.startsWith("packages:");
      if (!inPackages) continue;
      // "  /name@1.2.3:", "  name@1.2.3:", "  '@scope/name@1.2.3(peer@1.0.0)':"
      const match = line.match(/^ {2}'?\/?((?:@[^/@\s']+\/)?[^@\s'/]+)@(\d[^(:'\s]*)/);
      if (match) add(match[1], match[2]);
    }
    return [...seen.values()];
  }

  return null;
}

const SEVERITY_LEVELS: Record<string, OsvVulnerability["severity"]> = {
  CRITICAL: "critical",
  HIGH: "high",
  MODERATE: "moderate",
  MEDIUM: "moderate",
  LOW: "low",
};

interface OsvRecord {
  id: string;
  summary?: string;
  details?: string;
  published?: string;
  references?: Array<{ url?: string }>;
  database_specific?: { severity?: string };
  affected?: Array<{
    package?: { name?: string };
    ecosystem_specific?: { severity?: string };
    database_specific?: { informational?: string; cvss?: string | null };
    ranges?: Array<{ events?: Array<{ fixed?: string }> }>;
  }>;
}

/** Full advisory: the batch endpoint only returns ids, never the summary, severity or fix. */
async function fetchAdvisory(id: string): Promise<OsvRecord> {
  const resp = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`osv.dev returned HTTP ${resp.status} for advisory ${id}`);
  return await resp.json() as OsvRecord;
}

function describeAdvisory(record: OsvRecord, pkg: { name: string; version: string }, ecosystem: string): OsvVulnerability {
  const affected = record.affected?.find((a) => a.package?.name === pkg.name) ?? record.affected?.[0];
  const informational = affected?.database_specific?.informational;
  const kind: OsvVulnerability["kind"] =
    !informational ? "vulnerability"
      : informational === "unmaintained" || informational === "unsound" ? informational
      : "notice";
  const label = record.database_specific?.severity ?? affected?.ecosystem_specific?.severity;
  const fixed = affected?.ranges?.flatMap((r) => r.events ?? []).find((e) => e.fixed)?.fixed;

  return {
    id: record.id,
    summary: record.summary || record.details?.slice(0, 200) || "No description",
    kind,
    severity: (label && SEVERITY_LEVELS[label.toUpperCase()]) || (kind === "vulnerability" ? "moderate" : "low"),
    package: pkg.name,
    ecosystem,
    affectedRange: `${pkg.version} (installed)`,
    fixedVersion: fixed ?? null,
    url: `https://osv.dev/vulnerability/${record.id}`,
    published: record.published || "",
  };
}

export async function queryOsv(
  packages: Array<{ name: string; version: string }>,
  ecosystem: string
): Promise<OsvVulnerability[]> {
  const hits: Array<{ pkg: { name: string; version: string }; id: string }> = [];

  // OSV querybatch endpoint, in groups of 100. A failed request is an error: skipping it would
  // report the packages it held as free of vulnerabilities.
  for (let i = 0; i < packages.length; i += 100) {
    const batch = packages.slice(i, i + 100);
    const resp = await fetch("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries: batch.map((p) => ({ package: { name: p.name, ecosystem }, version: p.version })) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`osv.dev returned HTTP ${resp.status}: the scan is incomplete.`);
    const data = await resp.json() as { results: Array<{ vulns?: Array<{ id: string }> }> };
    data.results.forEach((result, j) => {
      for (const vuln of result.vulns ?? []) hits.push({ pkg: batch[j], id: vuln.id });
    });
  }

  const ids = [...new Set(hits.map((h) => h.id))];
  const records = new Map<string, OsvRecord>();
  for (let i = 0; i < ids.length; i += 8) {
    const fetched = await Promise.all(ids.slice(i, i + 8).map(fetchAdvisory));
    for (const record of fetched) records.set(record.id, record);
  }

  return hits.map(({ pkg, id }) => {
    const record = records.get(id);
    if (!record) throw new Error(`osv.dev advisory ${id} could not be read.`);
    return describeAdvisory(record, pkg, ecosystem);
  });
}

export async function liveAuditProject(
  projectPath: string,
  projectName: string,
  language: string
): Promise<LiveCveResult> {
  const ecosystem = ECOSYSTEM_MAP[language];
  if (!ecosystem) {
    return { project: projectName, vulnerabilities: [], packagesQueried: 0, source: "osv.dev", queriedAt: new Date().toISOString() };
  }

  const packages = getInstalledPackages(projectPath, language);
  const vulns = await queryOsv(packages, ecosystem);

  return {
    project: projectName,
    vulnerabilities: vulns,
    packagesQueried: packages.length,
    source: "osv.dev",
    queriedAt: new Date().toISOString(),
  };
}

export async function liveAuditAllProjects(
  projects: Array<{ name: string; path: string; language: string }>
): Promise<LiveCveResult[]> {
  const results: LiveCveResult[] = [];
  for (const p of projects) {
    const result = await liveAuditProject(p.path, p.name, p.language);
    if (result.vulnerabilities.length > 0) results.push(result);
  }
  return results;
}
