#!/usr/bin/env node

import { SERVER_NAME, SERVER_VERSION } from "./constants.js";

const args = process.argv.slice(2);

if (args.includes("--check") || args.includes("-c")) {
  // Background checker mode: scan, write cache, exit
  const { main } = await import("./checker.js");
} else if (args.includes("--dashboard") || args.includes("-d")) {
  // Dashboard mode with built-in scheduler
  await import("./dashboard.js");
} else if (args.includes("--daemon")) {
  // Headless daemon: background scan + auto-update, no HTTP server
  const { discoverProjects, getOutdated, isMajorUpdate, writeCache, loadConfig, buildUpdateCommand, run } = await import("./services/project.js");
  const SCAN_INTERVAL = 12 * 60 * 60 * 1000;
  const UPDATE_INTERVAL = 24 * 60 * 60 * 1000;

  async function daemonScan() {
    console.error(`[depsonar] Daemon scan starting...`);
    const projects = discoverProjects();
    const entries: any[] = [];
    for (const info of projects) {
      try {
        const outdated = getOutdated(info.path, info);
        const outdatedCount = Object.keys(outdated).length;
        const majorCount = Object.entries(outdated).filter(([, pkg]) => isMajorUpdate(pkg.current, pkg.latest)).length;
        let score = 100; score -= Math.min(outdatedCount * 3, 40); score -= majorCount * 10; score = Math.max(0, Math.min(100, score));
        entries.push({ project: info.name, path: info.path, language: info.language, framework: info.framework, outdatedCount, majorCount, securityIssues: 0, score, checkedAt: new Date().toISOString() });
      } catch {}
    }
    writeCache(entries);
    console.error(`[depsonar] Scan done: ${entries.length} projects.`);
  }

  async function daemonUpdate() {
    const config = loadConfig() as any;
    const autoList: string[] = config.autoUpdate || [];
    if (!autoList.length) return;
    console.error(`[depsonar] Auto-updating ${autoList.length} projects...`);
    const projects = discoverProjects();
    for (const name of autoList) {
      const info = projects.find(p => p.name === name);
      if (!info) continue;
      try { run(buildUpdateCommand(info, undefined, "minor"), info.path); console.error(`  ✓ ${name}`); }
      catch (e: any) { console.error(`  ✗ ${name}: ${e.message}`); }
    }
    await daemonScan();
  }

  console.error(`[depsonar] Daemon mode started. Scan every 12h, auto-update every 24h.`);
  console.error(`[depsonar] Toggle auto-update per project via dashboard or depsonar_config.`);
  await daemonScan();
  setInterval(daemonScan, SCAN_INTERVAL);
  setInterval(daemonUpdate, UPDATE_INTERVAL);
} else if (args.includes("--version") || args.includes("-v")) {
  console.log(`${SERVER_NAME} v${SERVER_VERSION}`);
} else if (args.includes("--help") || args.includes("-h")) {
  console.log(`${SERVER_NAME} v${SERVER_VERSION}

Usage:
  depsonar              Start MCP server (for Cursor/Claude)
  depsonar --dashboard  Start web dashboard with built-in scheduler
  depsonar --daemon     Headless background mode (scan + auto-update)
  depsonar --check      Run one-shot scan and exit
  depsonar --version    Show version
  depsonar --help       Show this help

MCP Tools:
  depsonar_alerts           Show pending alerts from background scans
  depsonar_scan             Scan all projects for outdated deps
  depsonar_check            Check a specific project
  depsonar_update           Update a project's dependencies
  depsonar_update_all       Batch update all projects
  depsonar_health           Health score for a project
  depsonar_install          Fresh install dependencies
  depsonar_audit            Security vulnerability scan (npm/pip/cargo audit)
  depsonar_cve              Known framework CVE advisory check
  depsonar_live_cve         Real-time CVE scan via osv.dev API
  depsonar_changelog        Changelogs & breaking changes before updating
  depsonar_migrate          Framework migration detector (Svelte 4→5, etc.)
  depsonar_deprecated       Deprecated & replaced package detection
  depsonar_secrets          Secret & API key scanner
  depsonar_licenses         License compliance check (GPL/AGPL flags)
  depsonar_runtimes         Check runtime versions (Node, Python, Rust...)
  depsonar_toolchain        Check global tool versions (npm, pnpm, git...)
  depsonar_docker           Audit Docker images for outdated/EOL
  depsonar_actions          Audit GitHub Actions versions
  depsonar_envcheck         Validate .env, lockfiles, configs
  depsonar_infra            Full infrastructure report (everything)
  depsonar_setup_checker    Setup automatic background scanning
  depsonar_config           View/edit configuration

Supported: Node.js, Python, Rust, Go, PHP, Ruby, Dart/Flutter, Swift, Kotlin/Java
Frameworks: SvelteKit, React, Next.js, Solid.js, Vue/Nuxt, Astro, Django, Laravel, Express
`);
} else {
  // Default: MCP server mode
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { registerTools } = await import("./tools/index.js");

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerTools(server);

  const { attachUpdateNotice, startUpdateCheck } = await import("./update-notice.js");
  const transport = attachUpdateNotice(new StdioServerTransport());
  startUpdateCheck("depsonar", SERVER_VERSION, "https://github.com/Soflutionltd/depsonar");
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}
