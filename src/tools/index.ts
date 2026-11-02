import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, basename, resolve } from "path";
import { homedir, platform } from "os";

import {
  CheckSchema,
  UpdateSchema,
  ScanSchema,
  UpdateAllSchema,
  HealthSchema,
  InstallSchema,
  ConfigSchema,
  AlertsSchema,
  SetupCronSchema,
  RuntimesSchema,
  ToolchainSchema,
  ActionsSchema,
  DockerSchema,
  EnvCheckSchema,
  AuditSchema,
  InfraSchema,
  CveSchema,
  DeprecatedSchema,
  SecretsSchema,
  LicensesSchema,
  LiveCveSchema,
  ChangelogSchema,
  MigrateSchema,
  DocsSchema,
  SearchPackageSchema,
} from "../schemas/index.js";

import { LANGUAGE_MARKERS } from "../constants.js";

import {
  getProjectsDir,
  getProjectInfo,
  discoverProjects,
  findProjectRoots,
  projectRootLabel,
  ROOT_SCAN_MAX_DEPTH,
  getOutdated,
  isMajorUpdate,
  computeHealthReport,
  buildUpdateCommand,
  getFrameworkVersion,
  run,
  readCache,
  getCacheStatus,
  loadConfig,
  saveConfig,
} from "../services/project.js";

import {
  formatOutdated,
  formatScanSummary,
  formatHealthReport,
  formatUpdateResult,
  formatBatchResult,
  formatCacheAlerts,
  formatRuntimes,
  formatToolchain,
  formatActions,
  formatDocker,
  formatEnvCheck,
  formatAudit,
  formatInfraReport,
  formatCve,
  formatDeprecated,
  formatSecrets,
  formatLicenses,
  formatLiveCve,
  formatChangelog,
  formatMigration,
} from "../services/formatter.js";

import { checkAllRuntimes, checkProjectVersionFiles } from "../services/runtimes.js";
import { checkAllTools } from "../services/toolchain.js";
import { scanWorkflows, scanAllProjectActions } from "../services/actions.js";
import { scanDockerfiles, scanAllProjectDocker } from "../services/docker.js";
import { checkProjectEnv, checkAllProjectEnvs } from "../services/envcheck.js";
import { auditProject, auditAllProjects } from "../services/audit.js";
import { checkAllProjectCves, getCveDatabaseStats, getCveDatabase } from "../services/cve.js";
import { checkDeprecated, checkAllDeprecated } from "../services/deprecated.js";
import { scanProjectSecrets, scanAllProjectSecrets } from "../services/secrets.js";
import { checkProjectLicenses, checkAllProjectLicenses } from "../services/licenses.js";
import { liveAuditProject, liveAuditAllProjects } from "../services/osv.js";
import { getProjectChangelog } from "../services/changelog.js";
import { detectMigration, detectAllMigrations } from "../services/migrate.js";
import { fetchLibraryDocs, searchPackage } from "../services/docs.js";

import type { Language } from "../types.js";

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function error(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

function resolveProject(project: string): string {
  if (existsSync(project) && (existsSync(join(project, "package.json")) ||
      existsSync(join(project, "Cargo.toml")) ||
      existsSync(join(project, "go.mod")) ||
      existsSync(join(project, "requirements.txt")) ||
      existsSync(join(project, "pyproject.toml")) ||
      existsSync(join(project, "composer.json")) ||
      existsSync(join(project, "Gemfile")) ||
      existsSync(join(project, "pubspec.yaml")) ||
      existsSync(join(project, "Package.swift")) ||
      existsSync(join(project, "build.gradle.kts")) ||
      existsSync(join(project, "build.gradle")))) {
    return resolve(project);
  }
  const fromDir = join(getProjectsDir(), project);
  if (existsSync(fromDir)) return fromDir;

  throw new Error(
    `Project "${project}" not found.\nUse depsonar_scan to list available projects.`
  );
}

export function registerTools(server: McpServer) {

  // ─── depsonar_alerts ─────────────────────────────────────────────────

  server.registerTool(
    "depsonar_alerts",
    {
      title: "Check Alerts",
      description: `Show pending dependency alerts from the last background scan. This reads the cache file written by the background checker (no live scan, instant response).

If no cache exists, suggests running depsonar_scan or setting up the background checker.

Examples:
  - "Any dependency alerts?"
  - "Do any of my projects need updates?"
  - "Show depsonar alerts"`,
      inputSchema: AlertsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const cache = readCache();
      if (!cache) {
        const status = getCacheStatus();
        return text(
          [
            "# No Recent Scan Data",
            "",
            "No background scan results found. You can:",
            "- Run `depsonar_scan` to scan now",
            "- Run `depsonar_setup_checker` to set up automatic background scans",
            "",
            status.exists ? `Last scan was too old to use.` : "No scan has been run yet.",
          ].join("\n")
        );
      }

      return text(formatCacheAlerts(cache));
    }
  );

  // ─── depsonar_check ──────────────────────────────────────────────────

  server.registerTool(
    "depsonar_check",
    {
      title: "Check Outdated Dependencies",
      description: `Check a project for outdated dependencies. Supports Node.js, Python, Rust, Go, PHP, Ruby, and Dart/Flutter.

Groups results by ecosystem for Node projects. Flags major version updates.

Examples:
  - "Check JobPin for outdated deps"
  - "What needs updating in my Django project?"`,
      inputSchema: CheckSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project }) => {
      try {
        const projectPath = resolveProject(project);
        const info = getProjectInfo(projectPath);
        if (!info) return error(`Cannot read project at ${projectPath}`);

        const outdated = getOutdated(projectPath, info);
        const fwVer = getFrameworkVersion(info);
        const langName = LANGUAGE_MARKERS[info.language]?.name || info.language;

        const header = [
          `# ${info.name}`,
          "",
          `**Language**: ${langName}`,
          `**Framework**: ${info.framework}${fwVer ? ` (${fwVer})` : ""}`,
          `**Package Manager**: ${info.packageManager}`,
          `**Path**: \`${projectPath}\``,
          "",
        ].join("\n");

        return text(header + formatOutdated(outdated, info.language));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_update ─────────────────────────────────────────────────

  server.registerTool(
    "depsonar_update",
    {
      title: "Update Dependencies",
      description: `Update dependencies for a project. Works with any supported language.

Three safety levels:
- patch: Bugfixes only (safest)
- minor: New features, no breaking changes (default)
- latest: Includes major breaking changes

Examples:
  - "Update all deps in JobPin"
  - "Update svelte in Showly to latest"
  - "Update my Python project dependencies"`,
      inputSchema: UpdateSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ project, packages, level, dry_run }) => {
      try {
        const projectPath = resolveProject(project);
        const info = getProjectInfo(projectPath);
        if (!info) return error(`Cannot read project at ${projectPath}`);

        const beforeOutdated = getOutdated(projectPath, info);
        const beforeCount = Object.keys(beforeOutdated).length;

        if (beforeCount === 0) {
          return text(`# ${info.name}\n\nAll dependencies are already up to date. ✅`);
        }

        if (dry_run) {
          return text(`# Preview: ${info.name}\n\n${formatOutdated(beforeOutdated, info.language)}`);
        }

        const cmd = buildUpdateCommand(info, packages, level);
        run(cmd, projectPath);

        const afterOutdated = getOutdated(projectPath, info);
        const afterCount = Object.keys(afterOutdated).length;

        return text(formatUpdateResult(info.name, cmd, beforeCount, afterCount, afterOutdated));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_scan ───────────────────────────────────────────────────

  server.registerTool(
    "depsonar_scan",
    {
      title: "Scan All Projects",
      description: `Scan all projects in your workspace. Auto-detects language (Node, Python, Rust, Go, PHP, Ruby, Dart) and framework.

Can filter by framework or language.

Examples:
  - "Scan all my projects"
  - "Which Python projects need updates?"
  - "Show all SvelteKit projects status"`,
      inputSchema: ScanSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ directory, framework, language }) => {
      try {
        let projects = discoverProjects(directory);
        if (projects.length === 0) {
          return text(`No projects found in \`${directory || getProjectsDir()}\`.\n\nUse \`depsonar_config\` to set your projects directory.`);
        }

        if (framework) {
          projects = projects.filter((p) => p.framework.toLowerCase() === framework.toLowerCase());
        }
        if (language) {
          projects = projects.filter((p) => p.language === language);
        }

        const results = projects.map((info) => {
          const outdated = getOutdated(info.path, info);
          const hasMajor = Object.entries(outdated).some(([, pkg]) => isMajorUpdate(pkg.current, pkg.latest));

          return {
            name: info.name,
            language: info.language,
            framework: info.framework,
            pm: info.packageManager,
            fwVersion: getFrameworkVersion(info),
            outdatedCount: Object.keys(outdated).length,
            hasMajor,
          };
        });

        return text(formatScanSummary(results));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_update_all ─────────────────────────────────────────────

  server.registerTool(
    "depsonar_update_all",
    {
      title: "Update All Projects",
      description: `Batch update across all projects. Defaults to dry_run=true (safe preview).

Can filter by framework or language.

Examples:
  - "Update all my projects"
  - "Update all SvelteKit projects, apply changes"
  - "Preview updates for all Python projects"`,
      inputSchema: UpdateAllSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ level, framework, language, dry_run, directory }) => {
      try {
        let projects = discoverProjects(directory);
        if (projects.length === 0) {
          return text("No projects found. Use `depsonar_config` to set your directory.");
        }

        if (framework) projects = projects.filter((p) => p.framework.toLowerCase() === framework.toLowerCase());
        if (language) projects = projects.filter((p) => p.language === language);

        const results: Array<{ name: string; updated: number; remaining: number; error?: string }> = [];

        for (const info of projects) {
          const beforeOutdated = getOutdated(info.path, info);
          const beforeCount = Object.keys(beforeOutdated).length;

          if (beforeCount === 0) {
            results.push({ name: info.name, updated: 0, remaining: 0 });
            continue;
          }

          if (dry_run) {
            results.push({ name: info.name, updated: beforeCount, remaining: 0 });
            continue;
          }

          try {
            const cmd = buildUpdateCommand(info, undefined, level);
            run(cmd, info.path);
            const afterOutdated = getOutdated(info.path, info);
            results.push({
              name: info.name,
              updated: beforeCount - Object.keys(afterOutdated).length,
              remaining: Object.keys(afterOutdated).length,
            });
          } catch (err) {
            results.push({
              name: info.name,
              updated: 0,
              remaining: beforeCount,
              error: err instanceof Error ? err.message.split("\n")[0] : String(err),
            });
          }
        }

        return text(formatBatchResult(results, dry_run));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_health ─────────────────────────────────────────────────

  server.registerTool(
    "depsonar_health",
    {
      title: "Health Report",
      description: `Score a project from 0-100. Checks outdated deps, security issues, lockfile.

Examples:
  - "How healthy is JobPin?"
  - "Health report for my Rust project"`,
      inputSchema: HealthSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project }) => {
      try {
        const projectPath = resolveProject(project);
        const info = getProjectInfo(projectPath);
        if (!info) return error(`Cannot read project at ${projectPath}`);
        return text(formatHealthReport(computeHealthReport(info)));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_install ────────────────────────────────────────────────

  server.registerTool(
    "depsonar_install",
    {
      title: "Install Dependencies",
      description: `Fresh install. Use clean=true to nuke node_modules/vendor first.

Examples:
  - "Install deps for JobPin"
  - "Clean install my project"`,
      inputSchema: InstallSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, clean }) => {
      try {
        const projectPath = resolveProject(project);
        const info = getProjectInfo(projectPath);
        if (!info) return error(`Cannot read project at ${projectPath}`);

        const marker = LANGUAGE_MARKERS[info.language];
        if (clean && marker?.cleanCmd) {
          run(marker.cleanCmd, projectPath);
        }

        const installCmd = info.language === "node"
          ? `${info.packageManager} install`
          : marker?.installCmd || "npm install";

        const output = run(installCmd, projectPath);
        const preview = output.length > 3000 ? output.slice(-3000) : output;

        return text(`# ${info.name}\n\n\`${installCmd}\`${clean ? " (clean)" : ""} done.\n\n\`\`\`\n${preview}\n\`\`\``);
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_setup_checker ──────────────────────────────────────────

  server.registerTool(
    "depsonar_setup_checker",
    {
      title: "Setup Background Checker",
      description: `Install or remove the background dependency checker. On macOS, uses launchd (native, lightweight). On Linux, uses cron.

The checker runs on schedule, scans all projects, writes results to ~/.depsonar-cache.json, then exits. Zero RAM between runs, zero AI tokens, zero cost.

Results are shown by depsonar_alerts.

Examples:
  - "Setup background dependency checking"
  - "Check my deps every 12 hours"
  - "Remove the background checker"`,
      inputSchema: SetupCronSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ interval_hours, uninstall }) => {
      try {
        const isMac = platform() === "darwin";

        if (isMac) {
          return text(setupLaunchd(interval_hours, uninstall));
        } else {
          return text(setupCron(interval_hours, uninstall));
        }
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_config ─────────────────────────────────────────────────

  server.registerTool(
    "depsonar_config",
    {
      title: "Configure depsonar",
      description: `View or update configuration. Saved to ~/.depsonarrc.json.

Examples:
  - "Show depsonar config"
  - "Set projects directory to ~/Code"`,
      inputSchema: ConfigSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ projects_dir, show }) => {
      try {
        if (show || !projects_dir) {
          const config = loadConfig();
          const cacheStatus = getCacheStatus();

          return text([
            "# DepUp Configuration",
            "",
            `**Projects directory**: \`${config.projectsDir}\``,
            `**Config file**: \`~/.depsonarrc.json\``,
            "",
            "### Background Checker",
            cacheStatus.exists
              ? `- Last scan: ${cacheStatus.age}`
              + `\n- Projects tracked: ${cacheStatus.projectCount}`
              + `\n- Alerts: ${cacheStatus.alerts}`
              : "- Not configured. Use `depsonar_setup_checker` to enable.",
            "",
            "### Supported Languages",
            ...Object.entries(LANGUAGE_MARKERS).map(([key, m]) => `- ${m.name} (${m.files.join(", ")})`),
          ].join("\n"));
        }

        const configPath = saveConfig({ projectsDir: resolve(projects_dir) });
        return text(`Projects directory set to \`${resolve(projects_dir)}\`.\nSaved to \`${configPath}\`.`);
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_audit ──────────────────────────────────────────────────

  server.registerTool(
    "depsonar_audit",
    {
      title: "Security Audit",
      description: `Scan projects for known security vulnerabilities (CVEs). Uses npm audit, cargo audit, pip-audit, composer audit, govulncheck.

CRITICAL: Run this after any CVE announcement (e.g. Svelte CVE-2026-22775, devalue DoS).

Examples:
  - "Audit all my projects for vulnerabilities"
  - "Security scan JobPin"
  - "Any CVEs in my SvelteKit projects?"`,
      inputSchema: AuditSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, directory }) => {
      try {
        const baseDir = project ? resolveProject(project) : directory || getProjectsDir();
        const roots = findProjectRoots(baseDir, "lockfile");
        if (roots.length === 0) {
          return text(`No lockfile found in \`${baseDir}\` (searched ${ROOT_SCAN_MAX_DEPTH} levels deep).`);
        }
        const results = roots.map(r => auditProject(r.path, projectRootLabel(baseDir, r), r.language));
        // With a single project, show every root, clean ones included.
        return text(formatAudit(project ? results : results.filter(r => r.totalVulnerabilities > 0 || r.error)));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_runtimes ───────────────────────────────────────────────

  server.registerTool(
    "depsonar_runtimes",
    {
      title: "Check Runtime Versions",
      description: `Check installed runtime versions (Node.js, Python, Rust, Go, PHP, Ruby, Dart, Swift). Detects EOL and outdated versions. Also checks project version files (.nvmrc, .python-version, rust-toolchain.toml, engines.node).

Examples:
  - "Check my runtime versions"
  - "Is my Node.js up to date?"
  - "Any runtime mismatches in my projects?"`,
      inputSchema: RuntimesSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ filter, check_projects, directory }) => {
      try {
        let runtimes = checkAllRuntimes();
        if (filter) {
          runtimes = runtimes.filter(r => r.name.toLowerCase().includes(filter.toLowerCase()));
        }

        let mismatches: any[] = [];
        if (check_projects) {
          const projects = discoverProjects(directory);
          mismatches = projects.flatMap(p => checkProjectVersionFiles(p.path, p.name));
        }

        return text(formatRuntimes(runtimes, mismatches));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_toolchain ──────────────────────────────────────────────

  server.registerTool(
    "depsonar_toolchain",
    {
      title: "Check Global Toolchain",
      description: `Check versions of globally installed tools: npm, pnpm, yarn, bun, composer, cargo, pip, typescript, git, docker, homebrew, vercel-cli, supabase-cli, wrangler.

Shows installed vs latest version and update commands.

Examples:
  - "Check my global tools"
  - "Is pnpm up to date?"
  - "Show all CLI tool versions"`,
      inputSchema: ToolchainSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ category }) => {
      try {
        let tools = checkAllTools();
        if (category) {
          tools = tools.filter(t => t.category.toLowerCase().includes(category.toLowerCase()));
        }
        return text(formatToolchain(tools));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_docker ─────────────────────────────────────────────────

  server.registerTool(
    "depsonar_docker",
    {
      title: "Docker Image Audit",
      description: `Scan Dockerfile and docker-compose files for outdated or EOL base images. Checks: node, python, ruby, php, golang, rust, nginx, postgres, redis, ubuntu, alpine.

Examples:
  - "Check my Docker images"
  - "Any EOL images in my projects?"`,
      inputSchema: DockerSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, directory }) => {
      try {
        if (project) {
          const projectPath = resolveProject(project);
          const info = getProjectInfo(projectPath);
          if (!info) return error(`Cannot read project at ${projectPath}`);
          const images = scanDockerfiles(projectPath, info.name);
          return text(formatDocker(images.length > 0 ? [{ project: info.name, images }] : []));
        }

        const projects = discoverProjects(directory);
        const results = scanAllProjectDocker(projects.map(p => ({ name: p.name, path: p.path })));
        return text(formatDocker(results));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_actions ────────────────────────────────────────────────

  server.registerTool(
    "depsonar_actions",
    {
      title: "GitHub Actions Audit",
      description: `Scan GitHub Actions workflow files for outdated or deprecated actions. Knows 30+ popular actions (actions/checkout, docker/build-push-action, cloudflare/wrangler-action, etc.).

Examples:
  - "Check my GitHub Actions versions"
  - "Any deprecated actions in my workflows?"`,
      inputSchema: ActionsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, directory }) => {
      try {
        if (project) {
          const projectPath = resolveProject(project);
          const info = getProjectInfo(projectPath);
          if (!info) return error(`Cannot read project at ${projectPath}`);
          const actions = scanWorkflows(projectPath, info.name);
          return text(formatActions(actions.length > 0 ? [{ project: info.name, actions }] : []));
        }

        const projects = discoverProjects(directory);
        const results = scanAllProjectActions(projects.map(p => ({ name: p.name, path: p.path })));
        return text(formatActions(results));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_envcheck ───────────────────────────────────────────────

  server.registerTool(
    "depsonar_envcheck",
    {
      title: "Environment & Config Check",
      description: `Validate project environments: .env/.env.example sync, lockfile freshness, tsconfig best practices, Svelte config (detects deprecated svelte-preprocess with Svelte 5, duplicate adapters, etc.), multiple lockfiles.

Examples:
  - "Check my project environments"
  - "Any env issues in JobPin?"
  - "Validate all project configs"`,
      inputSchema: EnvCheckSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, directory }) => {
      try {
        if (project) {
          const projectPath = resolveProject(project);
          const info = getProjectInfo(projectPath);
          if (!info) return error(`Cannot read project at ${projectPath}`);
          const issues = checkProjectEnv(projectPath, info.name);
          return text(formatEnvCheck(issues.length > 0 ? [{ project: info.name, issues }] : []));
        }

        const projects = discoverProjects(directory);
        const results = checkAllProjectEnvs(projects.map(p => ({ name: p.name, path: p.path })));
        return text(formatEnvCheck(results));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_infra ──────────────────────────────────────────────────

  server.registerTool(
    "depsonar_infra",
    {
      title: "Full Infrastructure Report",
      description: `Complete infrastructure health check in one command. Combines: runtime versions, global toolchain, security audit, CVE advisories, Docker images, GitHub Actions, environment configs, secret scanning, license compliance, deprecated packages, and optionally dependency scan.

This is the "run everything" command. Use when you want a full picture.

Examples:
  - "Full infrastructure report"
  - "Check everything"
  - "How's my dev environment?"`,
      inputSchema: InfraSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ directory, skip_deps }) => {
      try {
        const projects = discoverProjects(directory);
        const projectList = projects.map(p => ({ name: p.name, path: p.path, language: p.language }));

        // Runtimes
        const runtimes = checkAllRuntimes();
        const mismatches = projects.flatMap(p => checkProjectVersionFiles(p.path, p.name));
        const runtimesSection = formatRuntimes(runtimes, mismatches);

        // Toolchain
        const tools = checkAllTools();
        const toolchainSection = formatToolchain(tools);

        // Security audit
        const auditResults = auditAllProjects(projectList);
        const auditSection = formatAudit(auditResults);

        // Docker
        const dockerResults = scanAllProjectDocker(projectList.map(p => ({ name: p.name, path: p.path })));
        const dockerSection = formatDocker(dockerResults);

        // GitHub Actions
        const actionsResults = scanAllProjectActions(projectList.map(p => ({ name: p.name, path: p.path })));
        const actionsSection = formatActions(actionsResults);

        // Environment
        const envResults = checkAllProjectEnvs(projectList.map(p => ({ name: p.name, path: p.path })));
        const envSection = formatEnvCheck(envResults);

        // CVE Advisories
        const cveResults = checkAllProjectCves(projectList.map(p => ({ name: p.name, path: p.path })));
        const cveSection = formatCve(cveResults, getCveDatabaseStats());

        // Secrets
        const secretsResults = scanAllProjectSecrets(projectList.map(p => ({ name: p.name, path: p.path })));
        const secretsSection = formatSecrets(secretsResults);

        // Deprecated
        const deprecatedResults = checkAllDeprecated(projectList.map(p => ({ name: p.name, path: p.path })));
        const deprecatedSection = formatDeprecated(deprecatedResults);

        // Licenses
        const licenseResults = checkAllProjectLicenses(projectList.map(p => ({ name: p.name, path: p.path })));
        const licenseSection = formatLicenses(licenseResults);

        // Deps (optional)
        let depsSection: string | undefined;
        if (!skip_deps) {
          const scanResults = projects.map(info => {
            const outdated = getOutdated(info.path, info);
            const hasMajor = Object.entries(outdated).some(([, pkg]) => isMajorUpdate(pkg.current, pkg.latest));
            return {
              name: info.name, language: info.language, framework: info.framework,
              pm: info.packageManager, fwVersion: getFrameworkVersion(info),
              outdatedCount: Object.keys(outdated).length, hasMajor,
            };
          });
          depsSection = formatScanSummary(scanResults);
        }

        return text(formatInfraReport({
          runtimes: runtimesSection,
          toolchain: toolchainSection,
          audit: auditSection,
          cve: cveSection,
          docker: dockerSection,
          actions: actionsSection,
          env: envSection,
          secrets: secretsSection,
          deprecated: deprecatedSection,
          licenses: licenseSection,
          deps: depsSection,
        }));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_cve ────────────────────────────────────────────────────

  server.registerTool(
    "depsonar_cve",
    {
      title: "CVE Advisory Check",
      description: `Check projects against known framework CVEs (Svelte, SvelteKit, devalue, Next.js, Vite, Express, Axios). Goes beyond npm audit by checking a curated database of framework-specific vulnerabilities.

CRITICAL after any CVE announcement. Run immediately when new CVEs are published.

Examples:
  - "Check my projects for known CVEs"
  - "Any Svelte CVEs affecting my code?"
  - "Show CVE database"`,
      inputSchema: CveSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, directory, show_db }) => {
      try {
        const dbStats = getCveDatabaseStats();

        if (show_db) {
          const db = getCveDatabase();
          const lines = [`# CVE Advisory Database\n`, `${db.length} advisories | Last updated: ${dbStats.lastUpdate}\n`];
          for (const cve of db) {
            const emoji = cve.severity === "critical" ? "🔴" : cve.severity === "high" ? "🟠" : "🟡";
            lines.push(`- ${emoji} **${cve.id}** \`${cve.package}\` (${cve.severity}): ${cve.title}`);
            lines.push(`  Affected: ${cve.affectedVersions} | Fix: ${cve.patchedVersion}`);
          }
          return text(lines.join("\n"));
        }

        const baseDir = project ? resolveProject(project) : directory || getProjectsDir();
        const roots = findProjectRoots(baseDir, "manifest");
        if (roots.length === 0) {
          return text(`No project found in \`${baseDir}\` (searched ${ROOT_SCAN_MAX_DEPTH} levels deep).`);
        }
        const results = checkAllProjectCves(roots.map(r => ({ name: projectRootLabel(baseDir, r), path: r.path })));
        return text(formatCve(results, dbStats));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_deprecated ─────────────────────────────────────────────

  server.registerTool(
    "depsonar_deprecated",
    {
      title: "Deprecated Package Check",
      description: `Detect deprecated, unmaintained, or replaced packages. Checks both npm deprecated flags and a curated list of known replacements (moment→dayjs, node-fetch→native fetch, request→undici, etc.).

Examples:
  - "Any deprecated packages in my projects?"
  - "Check JobPin for deprecated deps"
  - "Find packages that should be replaced"`,
      inputSchema: DeprecatedSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, directory }) => {
      try {
        if (project) {
          const projectPath = resolveProject(project);
          const info = getProjectInfo(projectPath);
          if (!info) return error(`Cannot read project at ${projectPath}`);
          const result = checkDeprecated(projectPath, info.name);
          return text(formatDeprecated(result.deprecated.length > 0 ? [result] : []));
        }

        const projects = discoverProjects(directory);
        if (projects.length === 0) return text("No projects found.");
        const results = checkAllDeprecated(projects.map(p => ({ name: p.name, path: p.path })));
        return text(formatDeprecated(results));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_secrets ────────────────────────────────────────────────

  server.registerTool(
    "depsonar_secrets",
    {
      title: "Secret Scanner",
      description: `Scan project files for exposed secrets, API keys, tokens, and credentials. Detects: AWS keys, GitHub tokens, Stripe keys, Supabase JWT, OpenAI/Anthropic keys, private keys, database URLs, generic API key patterns.

Also checks that .env files are properly gitignored.

Examples:
  - "Scan my projects for exposed secrets"
  - "Any leaked API keys in JobPin?"
  - "Secret scan all projects"`,
      inputSchema: SecretsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, directory }) => {
      try {
        if (project) {
          const projectPath = resolveProject(project);
          const info = getProjectInfo(projectPath);
          if (!info) return error(`Cannot read project at ${projectPath}`);
          const result = scanProjectSecrets(projectPath, info.name);
          return text(formatSecrets(result.findings.length > 0 ? [result] : []));
        }

        const projects = discoverProjects(directory);
        if (projects.length === 0) return text("No projects found.");
        const results = scanAllProjectSecrets(projects.map(p => ({ name: p.name, path: p.path })));
        return text(formatSecrets(results));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_licenses ───────────────────────────────────────────────

  server.registerTool(
    "depsonar_licenses",
    {
      title: "License Compliance Check",
      description: `Check dependency licenses for commercial/SaaS compatibility. Flags: GPL/AGPL (copyleft, requires source disclosure), non-commercial (CC-BY-NC), unknown licenses.

Important for SaaS products to avoid legal issues.

Examples:
  - "Check license compliance for RoomPilot"
  - "Any GPL dependencies in my projects?"
  - "License audit all projects"`,
      inputSchema: LicensesSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, directory }) => {
      try {
        if (project) {
          const projectPath = resolveProject(project);
          const info = getProjectInfo(projectPath);
          if (!info) return error(`Cannot read project at ${projectPath}`);
          const result = checkProjectLicenses(projectPath, info.name);
          return text(formatLicenses(result.issues > 0 ? [result] : []));
        }

        const projects = discoverProjects(directory);
        if (projects.length === 0) return text("No projects found.");
        const results = checkAllProjectLicenses(projects.map(p => ({ name: p.name, path: p.path })));
        return text(formatLicenses(results));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_live_cve ───────────────────────────────────────────────

  server.registerTool(
    "depsonar_live_cve",
    {
      title: "Live CVE Scan (osv.dev)",
      description: `Real-time vulnerability scan using the osv.dev API. Checks every installed package against the global OSV database (npm, PyPI, crates.io, Go, Packagist, RubyGems, Pub).

Unlike depsonar_audit (which uses local tools like npm audit), this queries the live osv.dev database for the most up-to-date vulnerability data. No API key needed.

Examples:
  - "Live CVE scan all my projects"
  - "Check RoomPilot for vulnerabilities with osv.dev"
  - "Real-time security scan"`,
      inputSchema: LiveCveSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ project, directory }) => {
      try {
        if (project) {
          const projectPath = resolveProject(project);
          const info = getProjectInfo(projectPath);
          if (!info) return error(`Cannot read project at ${projectPath}`);
          const result = await liveAuditProject(projectPath, info.name, info.language);
          return text(formatLiveCve(result.vulnerabilities.length > 0 ? [result] : []));
        }

        const projects = discoverProjects(directory);
        if (projects.length === 0) return text("No projects found.");
        const results = await liveAuditAllProjects(
          projects.map(p => ({ name: p.name, path: p.path, language: p.language }))
        );
        return text(formatLiveCve(results));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_changelog ──────────────────────────────────────────────

  server.registerTool(
    "depsonar_changelog",
    {
      title: "Changelog & Breaking Changes",
      description: `Check changelogs and breaking changes before updating. Shows major/minor/patch breakdown with changelog URLs and release notes for breaking updates.

Run this BEFORE depsonar_update to understand what will change.

Examples:
  - "Show changelog for RoomPilot before updating"
  - "What breaking changes are pending in my project?"
  - "Check what changed in latest versions"`,
      inputSchema: ChangelogSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ project }) => {
      try {
        const projectPath = resolveProject(project);
        const info = getProjectInfo(projectPath);
        if (!info) return error(`Cannot read project at ${projectPath}`);
        const result = getProjectChangelog(projectPath, info.name);
        return text(formatChangelog(result));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_migrate ────────────────────────────────────────────────

  server.registerTool(
    "depsonar_migrate",
    {
      title: "Framework Migration Detector",
      description: `Detect framework migration needs by scanning code for deprecated patterns. Currently supports: Svelte 4→5, Next.js 13→14→15.

Finds exact file locations of code that needs to change, with migration instructions for each pattern.

Examples:
  - "Check if my projects need Svelte 5 migration"
  - "Migration scan for all projects"
  - "What Svelte 4 patterns are still in my code?"`,
      inputSchema: MigrateSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, directory }) => {
      try {
        if (project) {
          const projectPath = resolveProject(project);
          const info = getProjectInfo(projectPath);
          if (!info) return error(`Cannot read project at ${projectPath}`);
          const result = detectMigration(projectPath, info.name, info.framework);
          return text(formatMigration(result.migrationNeeded ? [result] : []));
        }

        const projects = discoverProjects(directory);
        if (projects.length === 0) return text("No projects found.");
        const results = detectAllMigrations(
          projects.map(p => ({ name: p.name, path: p.path, framework: p.framework }))
        );
        return text(formatMigration(results));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_docs ──────────────────────────────────────────────────

  server.registerTool(
    "depsonar_docs",
    {
      title: "Library Documentation (Context)",
      description: `Fetch up-to-date documentation, changelogs, and migration guides for any npm package directly from source (GitHub + npm registry).

Use this BEFORE writing code that depends on a library, to get the latest API docs and avoid hallucinating outdated APIs.

Sections available:
- **readme**: Latest README with API docs, examples, setup instructions
- **changelog**: Recent release notes (last 5 versions) with breaking changes
- **migration**: Migration/upgrade guides (supports Svelte, Next.js, Tailwind, Vite, Stripe, Supabase, Better Auth, etc.)

Combine with a query to focus on a specific topic (e.g. query="runes" for Svelte 5 migration docs).

Examples:
  - "Get Svelte 5 docs focused on runes migration"
  - "Show me the Supabase JS changelog"
  - "What changed in Tailwind CSS v4?"
  - "Get Better Auth setup docs"`,
      inputSchema: DocsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ package: pkg, query, sections }) => {
      try {
        const opts = {
          readme: !sections || sections === "all" || sections === "readme",
          changelog: !sections || sections === "all" || sections === "changelog",
          migration: !sections || sections === "all" || sections === "migration",
        };
        const result = await fetchLibraryDocs(pkg, query, opts);

        const parts: string[] = [];
        parts.push(`# 📚 ${result.package}@${result.version || "unknown"}`);
        if (result.description) parts.push(`> ${result.description}`);
        if (result.homepage) parts.push(`🔗 Homepage: ${result.homepage}`);
        if (result.repository) parts.push(`📦 Repository: ${result.repository}`);
        parts.push("");

        if (result.readme) {
          parts.push("---");
          parts.push("## README");
          parts.push(result.readme);
          parts.push("");
        }

        if (result.changelog) {
          parts.push("---");
          parts.push("## CHANGELOG (recent versions)");
          parts.push(result.changelog);
          parts.push("");
        }

        if (result.migrationGuide) {
          parts.push("---");
          parts.push("## MIGRATION GUIDE");
          parts.push(result.migrationGuide);
          parts.push("");
        }

        if (!result.readme && !result.changelog && !result.migrationGuide) {
          parts.push("No documentation found. The package may not be on npm or may not have a GitHub repository.");
        }

        return text(parts.join("\n"));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );

  // ─── depsonar_search_package ────────────────────────────────────────

  server.registerTool(
    "depsonar_search_package",
    {
      title: "Search npm Packages",
      description: `Search the npm registry for packages by name or keyword. Returns matching packages with name, latest version, and description.

Use this to find the right package name before calling depsonar_docs.

Examples:
  - "Search for Svelte authentication libraries"
  - "Find Stripe payment packages"
  - "What Tailwind utility packages exist?"`,
      inputSchema: SearchPackageSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query }) => {
      try {
        const results = await searchPackage(query);
        if (!results.length) return text(`No packages found for "${query}".`);

        const lines = [`# 🔍 npm search: "${query}"\n`];
        for (const r of results) {
          lines.push(`- **${r.name}** \`${r.version}\` — ${r.description}`);
        }
        lines.push("\n> Use `depsonar_docs` with the package name to get full documentation.");
        return text(lines.join("\n"));
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    }
  );
}

// ─── Scheduler Setup ───────────────────────────────────────────────────

function getCheckerPath(): string {
  // Find the checker script relative to this file
  const thisDir = new URL(".", import.meta.url).pathname;
  const checkerPath = join(thisDir, "checker.js");
  if (existsSync(checkerPath)) return checkerPath;

  // Fallback: try npx
  return ""; // will use npx
}

function setupLaunchd(intervalHours: number, uninstall: boolean): string {
  const plistName = "com.depsonar.checker";
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${plistName}.plist`);

  if (uninstall) {
    try {
      run(`launchctl unload ${plistPath}`, homedir());
    } catch { /* might not be loaded */ }
    if (existsSync(plistPath)) unlinkSync(plistPath);
    return `Background checker removed.\n\nDeleted: \`${plistPath}\``;
  }

  const checkerPath = getCheckerPath();
  const intervalSeconds = intervalHours * 3600;

  // Use npx as fallback if checker.js path not found
  const programArgs = checkerPath
    ? `    <string>node</string>\n    <string>${checkerPath}</string>`
    : `    <string>npx</string>\n    <string>depsonar</string>\n    <string>--check</string>`;

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistName}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), ".depsonar-checker.log")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`;

  writeFileSync(plistPath, plist, "utf-8");

  try {
    run(`launchctl unload ${plistPath}`, homedir());
  } catch { /* might not exist yet */ }
  run(`launchctl load ${plistPath}`, homedir());

  return [
    "# Background Checker Installed ✅",
    "",
    `**Schedule**: Every ${intervalHours} hour(s)`,
    `**Method**: macOS launchd (native, lightweight)`,
    `**Plist**: \`${plistPath}\``,
    `**Log**: \`~/.depsonar-checker.log\``,
    `**Cache**: \`~/.depsonar-cache.json\``,
    "",
    "The checker will run immediately, then every " + intervalHours + "h.",
    "It scans your projects, writes the cache, and exits. Zero RAM between runs.",
    "",
    "Use `depsonar_alerts` to see results.",
    "Use `depsonar_setup_checker` with `uninstall: true` to remove.",
  ].join("\n");
}

function setupCron(intervalHours: number, uninstall: boolean): string {
  const marker = "# depsonar background checker";

  try {
    const currentCron = run("crontab -l", homedir()).split("\n");
    const filtered = currentCron.filter((line) => !line.includes(marker) && !line.includes("depsonar"));

    if (uninstall) {
      const newCron = filtered.join("\n").trim() + "\n";
      writeFileSync("/tmp/depsonar-crontab", newCron, "utf-8");
      run("crontab /tmp/depsonar-crontab", homedir());
      unlinkSync("/tmp/depsonar-crontab");
      return "Background checker removed from crontab.";
    }

    const checkerPath = getCheckerPath();
    const cmd = checkerPath
      ? `node ${checkerPath}`
      : "npx --yes depsonar --check";

    const cronLine = `0 */${intervalHours} * * * ${cmd} 2>> ~/.depsonar-checker.log ${marker}`;
    filtered.push(cronLine);

    const newCron = filtered.join("\n").trim() + "\n";
    writeFileSync("/tmp/depsonar-crontab", newCron, "utf-8");
    run("crontab /tmp/depsonar-crontab", homedir());
    unlinkSync("/tmp/depsonar-crontab");

    return [
      "# Background Checker Installed ✅",
      "",
      `**Schedule**: Every ${intervalHours} hour(s)`,
      `**Method**: crontab`,
      `**Log**: \`~/.depsonar-checker.log\``,
      `**Cache**: \`~/.depsonar-cache.json\``,
      "",
      "Use `depsonar_alerts` to see results.",
    ].join("\n");
  } catch {
    return "Could not configure crontab. You can manually add this to your crontab:\n\n```\n0 */6 * * * npx --yes depsonar --check 2>> ~/.depsonar-checker.log\n```";
  }
}
