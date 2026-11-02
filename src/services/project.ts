import { execSync } from "child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from "fs";
import { join, basename, resolve, relative } from "path";
import { homedir } from "os";
import {
  COMMAND_TIMEOUT,
  ECOSYSTEM_GROUPS,
  FRAMEWORK_DETECTORS,
  LANGUAGE_MARKERS,
  CACHE_FILENAME,
  CACHE_MAX_AGE_MS,
  SERVER_VERSION,
} from "../constants.js";
import type {
  PackageManager,
  Language,
  OutdatedPackage,
  ProjectInfo,
  HealthReport,
  CacheFile,
  CacheEntry,
} from "../types.js";

// ─── Config ────────────────────────────────────────────────────────────

const DEFAULT_PROJECTS_DIRS = [
  join(homedir(), "Cursor", "App"),
  join(homedir(), "Projects"),
  join(homedir(), "Developer"),
  join(homedir(), "Code"),
  join(homedir(), "dev"),
];

export function getProjectsDir(): string {
  const configPaths = [
    join(homedir(), ".depsonarrc.json"),
    join(homedir(), ".config", "depsonar", "config.json"),
  ];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        if (config.projectsDir && existsSync(config.projectsDir)) {
          return resolve(config.projectsDir);
        }
      } catch { /* ignore */ }
    }
  }

  const envDir = process.env.DEPUP_PROJECTS_DIR;
  if (envDir && existsSync(envDir)) return resolve(envDir);

  for (const dir of DEFAULT_PROJECTS_DIRS) {
    if (existsSync(dir)) return dir;
  }

  return join(homedir(), "Projects");
}

// ─── Shell Execution ───────────────────────────────────────────────────

export function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout: COMMAND_TIMEOUT,
      shell: "/bin/sh",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "stdout" in err) {
      const stdout = (err as { stdout: string }).stdout;
      if (stdout) return stdout;
    }
    const message =
      err instanceof Error ? err.message
        : err && typeof err === "object" && "stderr" in err ? String((err as { stderr: string }).stderr)
        : String(err);
    throw new Error(`Command failed: ${cmd}\n${message}`);
  }
}

function cmdExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

// ─── Language Detection ────────────────────────────────────────────────

export function detectLanguage(dir: string): Language {
  for (const [lang, marker] of Object.entries(LANGUAGE_MARKERS)) {
    if (marker.files.some((f) => existsSync(join(dir, f)))) {
      return lang as Language;
    }
  }
  return "node"; // default
}

export function detectPackageManager(dir: string): PackageManager {
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

export function detectFramework(dir: string): string {
  for (const [name, files] of Object.entries(FRAMEWORK_DETECTORS)) {
    if (files.some((f) => {
      // Handle glob patterns for Xcode
      if (f.startsWith("*.")) {
        const ext = f.slice(1);
        try {
          return readdirSync(dir).some((entry) => entry.endsWith(ext));
        } catch { return false; }
      }
      return existsSync(join(dir, f));
    })) return name;
  }

  const lang = detectLanguage(dir);
  try {
    if (lang === "node") {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Frameworks (order matters: specific before generic)
      if (allDeps["solid-start"]) return "SolidStart";
      if (allDeps["solid-js"]) return "Solid.js";
      if (allDeps["@sveltejs/kit"]) return "SvelteKit";
      if (allDeps["svelte"]) return "Svelte";
      if (allDeps["next"]) return "Next.js";
      if (allDeps["react"]) return "React";
      if (allDeps["vue"]) return "Vue";
      if (allDeps["express"]) return "Express";
      if (allDeps["fastify"]) return "Fastify";
      if (allDeps["hono"]) return "Hono";
    }
  } catch { /* ignore */ }

  return LANGUAGE_MARKERS[lang]?.name || "Unknown";
}

export function getProjectInfo(dir: string): ProjectInfo | null {
  const lang = detectLanguage(dir);

  // Must have at least one marker file
  const marker = LANGUAGE_MARKERS[lang];
  if (!marker || !marker.files.some((f) => existsSync(join(dir, f)))) return null;

  let deps: Record<string, string> = {};
  let devDeps: Record<string, string> = {};
  let name = basename(dir);
  let nodeVersion: string | undefined;

  if (lang === "node") {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      name = pkg.name || name;
      deps = pkg.dependencies || {};
      devDeps = pkg.devDependencies || {};
      nodeVersion = pkg.engines?.node;
    } catch { /* ignore */ }
  } else if (lang === "python") {
    // Read requirements.txt or pyproject.toml for dep names
    try {
      if (existsSync(join(dir, "requirements.txt"))) {
        const lines = readFileSync(join(dir, "requirements.txt"), "utf-8").split("\n");
        for (const line of lines) {
          const match = line.trim().match(/^([a-zA-Z0-9_-]+)/);
          if (match && !line.startsWith("#")) deps[match[1]] = "*";
        }
      }
    } catch { /* ignore */ }
  } else if (lang === "rust") {
    try {
      const cargo = readFileSync(join(dir, "Cargo.toml"), "utf-8");
      const nameMatch = cargo.match(/name\s*=\s*"([^"]+)"/);
      if (nameMatch) name = nameMatch[1];
    } catch { /* ignore */ }
  } else if (lang === "go") {
    try {
      const gomod = readFileSync(join(dir, "go.mod"), "utf-8");
      const moduleMatch = gomod.match(/module\s+(\S+)/);
      if (moduleMatch) name = moduleMatch[1].split("/").pop() || name;
    } catch { /* ignore */ }
  } else if (lang === "php") {
    try {
      const composer = JSON.parse(readFileSync(join(dir, "composer.json"), "utf-8"));
      name = composer.name || name;
      deps = composer.require || {};
      devDeps = composer["require-dev"] || {};
    } catch { /* ignore */ }
  }

  return {
    name,
    path: dir,
    language: lang,
    framework: detectFramework(dir),
    packageManager: lang === "node" ? detectPackageManager(dir) : "npm",
    nodeVersion,
    dependencies: deps,
    devDependencies: devDeps,
  };
}

export function discoverProjects(rootDir?: string): ProjectInfo[] {
  const dir = rootDir || getProjectsDir();
  if (!existsSync(dir)) return [];

  const projects: ProjectInfo[] = [];

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const fullPath = join(dir, entry.name);
      const info = getProjectInfo(fullPath);
      if (info) projects.push(info);
    }
  } catch { /* ignore */ }

  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Project Roots (monorepos, nested apps) ────────────────────────────

/** Files an audit tool reads: a folder holding one of them is audited on its own. */
export const AUDIT_LOCKFILES = [
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "Cargo.lock", "composer.lock", "go.sum", "poetry.lock", "Pipfile.lock", "uv.lock", "requirements.txt",
];
export const ROOT_SCAN_MAX_DEPTH = 4;
const ROOT_SCAN_SKIP = new Set(["node_modules", "build", "dist", "target", "vendor", "Pods"]);

/**
 * Finds every project inside `rootDir`, `rootDir` included, down to ROOT_SCAN_MAX_DEPTH levels.
 * "lockfile": folders with a lockfile, one audit each (workspace members share the root's).
 * "manifest": folders with a manifest such as package.json, workspace members included.
 */
export function findProjectRoots(rootDir: string, mode: "lockfile" | "manifest"): ProjectInfo[] {
  const roots: ProjectInfo[] = [];

  const walk = (dir: string, depth: number): void => {
    if (mode === "manifest" || AUDIT_LOCKFILES.some((f) => existsSync(join(dir, f)))) {
      const info = getProjectInfo(dir);
      if (info) roots.push(info);
    }
    if (depth >= ROOT_SCAN_MAX_DEPTH) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || ROOT_SCAN_SKIP.has(entry.name)) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };

  const start = resolve(rootDir);
  if (existsSync(start)) walk(start, 0);
  return roots.sort((a, b) => a.path.localeCompare(b.path));
}

/** "name (relative/path)" so that nested apps with the same package name stay distinct. */
export function projectRootLabel(baseDir: string, info: ProjectInfo): string {
  return `${info.name} (${relative(resolve(baseDir), info.path) || "."})`;
}

// ─── Multi-language Outdated Parsing ───────────────────────────────────

export function getOutdated(
  projectPath: string,
  info: ProjectInfo
): Record<string, OutdatedPackage> {
  const marker = LANGUAGE_MARKERS[info.language];
  if (!marker) return {};

  switch (marker.parseOutdated) {
    case "npm":
      return getOutdatedNpm(projectPath, info.packageManager);
    case "pip":
      return getOutdatedPip(projectPath);
    case "cargo":
      return getOutdatedCargo(projectPath);
    case "go":
      return getOutdatedGo(projectPath);
    case "composer":
      return getOutdatedComposer(projectPath);
    case "gem":
      return getOutdatedGem(projectPath);
    case "pub":
      return getOutdatedPub(projectPath);
    case "swift":
      return getOutdatedSwift(projectPath);
    case "gradle":
      return getOutdatedGradle(projectPath);
    default:
      return {};
  }
}

function getOutdatedNpm(projectPath: string, pm: PackageManager): Record<string, OutdatedPackage> {
  try {
    const raw = run(`${pm} outdated --json`, projectPath);
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      const result: Record<string, OutdatedPackage> = {};
      for (const item of parsed) {
        result[item.name || item.package] = {
          current: item.current || "?",
          wanted: item.wanted || item.current || "?",
          latest: item.latest || "?",
          type: item.dependencyType,
        };
      }
      return result;
    }
    return parsed;
  } catch { return {}; }
}

function getOutdatedPip(projectPath: string): Record<string, OutdatedPackage> {
  if (!cmdExists("pip") && !cmdExists("pip3")) return {};
  try {
    const pipCmd = cmdExists("pip3") ? "pip3" : "pip";
    const raw = run(`${pipCmd} list --outdated --format=json`, projectPath);
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw) as Array<{ name: string; version: string; latest_version: string }>;

    const result: Record<string, OutdatedPackage> = {};
    for (const item of parsed) {
      result[item.name] = {
        current: item.version,
        wanted: item.latest_version,
        latest: item.latest_version,
      };
    }
    return result;
  } catch { return {}; }
}

function getOutdatedCargo(projectPath: string): Record<string, OutdatedPackage> {
  if (!cmdExists("cargo")) return {};
  // cargo outdated requires cargo-outdated plugin, fallback to cargo update --dry-run
  try {
    if (cmdExists("cargo-outdated")) {
      const raw = run("cargo outdated --format json", projectPath);
      if (!raw.trim()) return {};
      const parsed = JSON.parse(raw);
      const result: Record<string, OutdatedPackage> = {};
      for (const dep of parsed.dependencies || []) {
        if (dep.project !== dep.latest) {
          result[dep.name] = {
            current: dep.project,
            wanted: dep.compat,
            latest: dep.latest,
          };
        }
      }
      return result;
    }
    // Fallback: parse Cargo.lock vs crates.io (simplified)
    return {};
  } catch { return {}; }
}

function getOutdatedGo(projectPath: string): Record<string, OutdatedPackage> {
  if (!cmdExists("go")) return {};
  try {
    const raw = run("go list -m -u -json all", projectPath);
    if (!raw.trim()) return {};

    // go list outputs multiple JSON objects, not an array
    const result: Record<string, OutdatedPackage> = {};
    const objects = raw.split("\n}\n").filter((s) => s.trim());

    for (let obj of objects) {
      obj = obj.trim();
      if (!obj.endsWith("}")) obj += "}";
      try {
        const parsed = JSON.parse(obj);
        if (parsed.Update && parsed.Version) {
          const name = parsed.Path.split("/").slice(-2).join("/");
          result[name] = {
            current: parsed.Version,
            wanted: parsed.Update.Version,
            latest: parsed.Update.Version,
          };
        }
      } catch { /* skip malformed */ }
    }
    return result;
  } catch { return {}; }
}

function getOutdatedComposer(projectPath: string): Record<string, OutdatedPackage> {
  if (!cmdExists("composer")) return {};
  try {
    const raw = run("composer outdated --format=json --direct", projectPath);
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);

    const result: Record<string, OutdatedPackage> = {};
    for (const item of parsed.installed || []) {
      if (item.version !== item.latest) {
        result[item.name] = {
          current: item.version,
          wanted: item.latest,
          latest: item.latest,
        };
      }
    }
    return result;
  } catch { return {}; }
}

function getOutdatedGem(projectPath: string): Record<string, OutdatedPackage> {
  if (!cmdExists("bundle")) return {};
  try {
    const raw = run("bundle outdated --parseable", projectPath);
    if (!raw.trim()) return {};

    const result: Record<string, OutdatedPackage> = {};
    for (const line of raw.split("\n")) {
      // Format: gem-name (newest X.Y.Z, installed X.Y.Z)
      const match = line.match(/(\S+)\s+\(newest\s+(\S+),\s+installed\s+(\S+)/);
      if (match) {
        result[match[1]] = {
          current: match[3],
          wanted: match[2],
          latest: match[2],
        };
      }
    }
    return result;
  } catch { return {}; }
}

function getOutdatedPub(projectPath: string): Record<string, OutdatedPackage> {
  if (!cmdExists("dart") && !cmdExists("flutter")) return {};
  try {
    const cmd = cmdExists("flutter") ? "flutter pub outdated --json" : "dart pub outdated --json";
    const raw = run(cmd, projectPath);
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);

    const result: Record<string, OutdatedPackage> = {};
    for (const pkg of parsed.packages || []) {
      if (pkg.current?.version && pkg.latest?.version && pkg.current.version !== pkg.latest.version) {
        result[pkg.package] = {
          current: pkg.current.version,
          wanted: pkg.resolvable?.version || pkg.latest.version,
          latest: pkg.latest.version,
        };
      }
    }
    return result;
  } catch { return {}; }
}

function getOutdatedSwift(projectPath: string): Record<string, OutdatedPackage> {
  if (!cmdExists("swift")) return {};
  try {
    // Swift PM doesn't have a built-in outdated command
    // Parse Package.resolved and compare with latest tags
    const resolvedPath = join(projectPath, "Package.resolved");
    if (!existsSync(resolvedPath)) return {};

    const resolved = JSON.parse(readFileSync(resolvedPath, "utf-8"));
    const result: Record<string, OutdatedPackage> = {};

    // v2 format
    const pins = resolved.pins || resolved.object?.pins || [];
    for (const pin of pins) {
      const name = pin.identity || pin.package || pin.repositoryURL?.split("/").pop()?.replace(".git", "");
      const version = pin.state?.version || pin.state?.revision?.slice(0, 8);
      if (name && version) {
        result[name] = {
          current: version,
          wanted: version,
          latest: version, // Can't check latest without network calls to each repo
        };
      }
    }
    return result;
  } catch { return {}; }
}

function getOutdatedGradle(projectPath: string): Record<string, OutdatedPackage> {
  // Requires gradle-versions-plugin (com.github.ben-manes.versions)
  const gradlew = join(projectPath, "gradlew");
  if (!existsSync(gradlew) && !cmdExists("gradle")) return {};

  try {
    const cmd = existsSync(gradlew)
      ? "./gradlew dependencyUpdates -Drevision=release --output-formatter json"
      : "gradle dependencyUpdates -Drevision=release --output-formatter json";

    const raw = run(cmd, projectPath);

    // Look for the JSON report file
    const reportPath = join(projectPath, "build", "dependencyUpdates", "report.json");
    if (!existsSync(reportPath)) return {};

    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    const result: Record<string, OutdatedPackage> = {};

    for (const dep of report.outdated?.dependencies || []) {
      const name = dep.group ? `${dep.group}:${dep.name}` : dep.name;
      result[name] = {
        current: dep.version || "?",
        wanted: dep.available?.release || dep.available?.milestone || dep.version,
        latest: dep.available?.release || dep.available?.milestone || dep.version,
      };
    }
    return result;
  } catch { return {}; }
}

// ─── Ecosystem Grouping ────────────────────────────────────────────────

export function groupByEcosystem(
  outdated: Record<string, OutdatedPackage>
): Record<string, [string, OutdatedPackage][]> {
  const groups: Record<string, [string, OutdatedPackage][]> = {};

  for (const [name, info] of Object.entries(outdated)) {
    let matched = false;
    for (const [ecosystem, pattern] of Object.entries(ECOSYSTEM_GROUPS)) {
      if (pattern.test(name)) {
        if (!groups[ecosystem]) groups[ecosystem] = [];
        groups[ecosystem].push([name, info]);
        matched = true;
        break;
      }
    }
    if (!matched) {
      if (!groups["other"]) groups["other"] = [];
      groups["other"].push([name, info]);
    }
  }

  return groups;
}

export function isMajorUpdate(current: string, latest: string): boolean {
  const curMajor = current.replace(/^[^0-9]*/, "").split(".")[0];
  const latMajor = latest.replace(/^[^0-9]*/, "").split(".")[0];
  return curMajor !== latMajor && curMajor !== "" && latMajor !== "";
}

export function getFrameworkVersion(info: ProjectInfo): string | null {
  const allDeps = { ...info.dependencies, ...info.devDependencies };
  switch (info.framework) {
    case "SvelteKit": return allDeps["@sveltejs/kit"] || allDeps["svelte"] || null;
    case "Svelte": return allDeps["svelte"] || null;
    case "Next.js": return allDeps["next"] || null;
    case "React": return allDeps["react"] || null;
    case "Nuxt": return allDeps["nuxt"] || null;
    case "Vue": return allDeps["vue"] || null;
    case "Astro": return allDeps["astro"] || null;
    case "SolidStart": return allDeps["solid-start"] || allDeps["solid-js"] || null;
    case "Solid.js": return allDeps["solid-js"] || null;
    default: return null;
  }
}

// ─── Security Audit ────────────────────────────────────────────────────

export function getSecurityIssues(projectPath: string, info: ProjectInfo): number {
  const marker = LANGUAGE_MARKERS[info.language];
  if (!marker?.auditCmd) return 0;

  try {
    const cmd = marker.auditCmd.replace(/\{pm\}/g, info.packageManager);
    if (!cmdExists(cmd.split(" ")[0])) return 0;

    const raw = run(cmd, projectPath);
    const parsed = JSON.parse(raw);

    // npm format
    if (parsed.metadata?.vulnerabilities) {
      const v = parsed.metadata.vulnerabilities;
      return (v.high || 0) + (v.critical || 0) + (v.moderate || 0);
    }
    return 0;
  } catch { return 0; }
}

// ─── Health Score ──────────────────────────────────────────────────────

export function computeHealthReport(info: ProjectInfo): HealthReport {
  const outdated = getOutdated(info.path, info);
  const outdatedCount = Object.keys(outdated).length;
  const majorUpdates = Object.entries(outdated).filter(([, pkg]) =>
    isMajorUpdate(pkg.current, pkg.latest)
  ).length;

  const lockfiles = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb",
    "Cargo.lock", "go.sum", "composer.lock", "Gemfile.lock", "pubspec.lock", "Pipfile.lock",
    "Package.resolved", "gradle.lockfile"];
  const lockfileExists = lockfiles.some((lf) => existsSync(join(info.path, lf)));

  let score = 100;
  score -= Math.min(outdatedCount * 3, 40);
  score -= majorUpdates * 10;
  if (!lockfileExists) score -= 15;

  const securityIssues = getSecurityIssues(info.path, info);
  score -= Math.min(securityIssues * 5, 30);
  score = Math.max(0, Math.min(100, score));

  const recommendations: string[] = [];
  if (!lockfileExists) recommendations.push(`Missing lockfile. Run install to generate one.`);
  if (majorUpdates > 0) recommendations.push(`${majorUpdates} major update(s). Review changelogs before updating.`);
  if (securityIssues > 0) recommendations.push(`${securityIssues} security issue(s). Run audit fix.`);
  if (outdatedCount > 10) recommendations.push("Many outdated packages. Start with minor/patch updates.");
  if (score === 100) recommendations.push("All good! Dependencies are up to date.");

  return {
    project: info.name,
    language: info.language,
    framework: info.framework,
    frameworkVersion: getFrameworkVersion(info),
    nodeVersion: info.nodeVersion ?? null,
    packageManager: info.packageManager,
    lockfileExists,
    outdatedCount,
    majorUpdates,
    securityIssues,
    score,
    recommendations,
  };
}

// ─── Update Commands ───────────────────────────────────────────────────

export function buildUpdateCommand(info: ProjectInfo, packages: string | undefined, level: string): string {
  const marker = LANGUAGE_MARKERS[info.language];
  if (!marker) return `${info.packageManager} update`;

  if (info.language === "node") {
    const pm = info.packageManager;
    const pkgList = packages?.trim() || "";
    if (pm === "pnpm") {
      if (pkgList) return level === "latest" ? `pnpm update ${pkgList} --latest` : `pnpm update ${pkgList}`;
      return level === "latest" ? "pnpm update --latest" : "pnpm update";
    }
    if (pm === "yarn") {
      if (pkgList) return level === "latest" ? `yarn upgrade ${pkgList} --latest` : `yarn upgrade ${pkgList}`;
      return level === "latest" ? "yarn upgrade --latest" : "yarn upgrade";
    }
    if (pm === "bun") return pkgList ? `bun update ${pkgList}` : "bun update";
    // npm: npm update only bumps within semver range, useless for real updates
    // Use npx npm-check-updates to actually bump package.json then npm install
    if (level === "latest") {
      if (pkgList) return `npx -y npm-check-updates -u ${pkgList.split(" ").join(" ")} && npm install`;
      return "npx -y npm-check-updates -u && npm install";
    }
    // minor: bump minor+patch only
    if (pkgList) return `npx -y npm-check-updates -u --target minor ${pkgList.split(" ").join(" ")} && npm install`;
    return "npx -y npm-check-updates -u --target minor && npm install";
  }

  if (info.language === "python") {
    const pkgList = packages?.trim() || "";
    if (pkgList) return `pip install --upgrade ${pkgList}`;
    return `pip install --upgrade -r requirements.txt`;
  }

  return level === "latest" ? marker.updateLatestCmd : marker.updateCmd;
}

// ─── Cache ─────────────────────────────────────────────────────────────

function getCachePath(): string {
  return join(homedir(), CACHE_FILENAME);
}

export function readCache(): CacheFile | null {
  const path = getCachePath();
  if (!existsSync(path)) return null;

  try {
    const stat = statSync(path);
    const age = Date.now() - stat.mtimeMs;
    if (age > CACHE_MAX_AGE_MS) return null; // expired

    return JSON.parse(readFileSync(path, "utf-8"));
  } catch { return null; }
}

export function writeCache(entries: CacheEntry[]): void {
  const cache: CacheFile = {
    version: SERVER_VERSION,
    updatedAt: new Date().toISOString(),
    projects: entries,
  };
  writeFileSync(getCachePath(), JSON.stringify(cache, null, 2) + "\n", "utf-8");
}

export function getCacheStatus(): { exists: boolean; age: string; projectCount: number; alerts: number } {
  const cache = readCache();
  if (!cache) return { exists: false, age: "none", projectCount: 0, alerts: 0 };

  const ageMs = Date.now() - new Date(cache.updatedAt).getTime();
  const hours = Math.floor(ageMs / 3600000);
  const minutes = Math.floor((ageMs % 3600000) / 60000);
  const age = hours > 0 ? `${hours}h ${minutes}m ago` : `${minutes}m ago`;

  const alerts = cache.projects.filter((p) => p.outdatedCount > 0).length;

  return { exists: true, age, projectCount: cache.projects.length, alerts };
}

// ─── Config ────────────────────────────────────────────────────────────

export function loadConfig(): { projectsDir: string; ignoredPackages: string[] } {
  const configPaths = [
    join(homedir(), ".depsonarrc.json"),
    join(homedir(), ".config", "depsonar", "config.json"),
  ];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const raw = JSON.parse(readFileSync(configPath, "utf-8"));
        return {
          projectsDir: raw.projectsDir ? resolve(raw.projectsDir) : getProjectsDir(),
          ignoredPackages: raw.ignoredPackages || [],
        };
      } catch { /* ignore */ }
    }
  }
  return { projectsDir: getProjectsDir(), ignoredPackages: [] };
}

export function saveConfig(config: Record<string, unknown>): string {
  const configPath = join(homedir(), ".depsonarrc.json");
  const existing = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf-8"))
    : {};
  const merged = { ...existing, ...config };
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  return configPath;
}
