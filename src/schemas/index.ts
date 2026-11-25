import { z } from "zod";

// An argument a tool does not declare is refused, never silently dropped: a misspelled
// `project` (`path`, `dir`) used to fall back to scanning every project.
function strictInput<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.strictObject(shape);
}

const ALL_PROJECTS_HINT =
  "Set to true to cover every project in the projects directory. Required when neither `project` nor `directory` is given.";

export const ProjectInputSchema = {
  project: z.string().describe(
    "Project name (e.g. 'my-app') or full absolute path."
  ),
};

export const CheckSchema = strictInput({ ...ProjectInputSchema });

export const UpdateSchema = strictInput({
  ...ProjectInputSchema,
  packages: z.string().optional().describe(
    "Space-separated packages to update. Leave empty for all."
  ),
  level: z.enum(["patch", "minor", "latest"]).default("minor").describe(
    "'patch' (bugfixes), 'minor' (features, safe), 'latest' (major, review first)"
  ),
  dry_run: z.boolean().default(false).describe("Preview without changing anything."),
});

export const ScanSchema = strictInput({
  directory: z.string().optional().describe("Root directory to scan."),
  framework: z.string().optional().describe("Filter: 'SvelteKit', 'Next.js', 'Django', etc."),
  language: z.string().optional().describe("Filter: 'node', 'python', 'rust', 'go', 'php', 'ruby', 'dart', 'swift', 'kotlin'."),
});

export const UpdateAllSchema = strictInput({
  level: z.enum(["patch", "minor", "latest"]).default("minor"),
  framework: z.string().optional().describe("Only update this framework."),
  language: z.string().optional().describe("Only update this language."),
  dry_run: z.boolean().default(true).describe("Defaults to true (safe preview)."),
  directory: z.string().optional(),
});

export const HealthSchema = strictInput({ ...ProjectInputSchema });

export const InstallSchema = strictInput({
  ...ProjectInputSchema,
  clean: z.boolean().default(false).describe("Delete node_modules/vendor before install."),
});

export const ConfigSchema = strictInput({
  projects_dir: z.string().optional().describe("Set root projects directory."),
  show: z.boolean().default(false).describe("Show current config."),
});

export const AlertsSchema = strictInput({});

export const SetupCronSchema = strictInput({
  interval_hours: z.number().default(6).describe("How often to check (in hours). Default: every 6 hours."),
  uninstall: z.boolean().default(false).describe("Remove the scheduled check."),
});

// ─── NEW v2 Schemas ────────────────────────────────────────────────────

export const RuntimesSchema = strictInput({
  filter: z.string().optional().describe("Filter by runtime name: 'node', 'python', 'rust', 'go', 'php', 'ruby', 'dart', 'swift'."),
  check_projects: z.boolean().default(true).describe("Also check project-level version files (.nvmrc, .python-version, etc.)."),
  directory: z.string().optional().describe("Project directory to scan for version files."),
});

export const ToolchainSchema = strictInput({
  category: z.string().optional().describe("Filter by category: 'Package Managers', 'Build Tools', 'Dev Tools', 'CLI Tools'."),
});

export const ActionsSchema = strictInput({
  project: z.string().optional().describe("Scan a specific project. Without it, pass `directory` or `all: true`."),
  directory: z.string().optional().describe("Root directory to scan."),
  all: z.boolean().default(false).describe(ALL_PROJECTS_HINT),
});

export const DockerSchema = strictInput({
  project: z.string().optional().describe("Scan a specific project. Without it, pass `directory` or `all: true`."),
  directory: z.string().optional().describe("Root directory to scan."),
  all: z.boolean().default(false).describe(ALL_PROJECTS_HINT),
});

export const EnvCheckSchema = strictInput({
  project: z.string().optional().describe("Check a specific project. Without it, pass `directory` or `all: true`."),
  directory: z.string().optional().describe("Root directory to scan."),
  all: z.boolean().default(false).describe(ALL_PROJECTS_HINT),
});

export const AuditSchema = strictInput({
  project: z.string().optional().describe("Audit a specific project. Without it, pass `directory` or `all: true`."),
  directory: z.string().optional().describe("Root directory to scan."),
  all: z.boolean().default(false).describe(ALL_PROJECTS_HINT),
});

export const InfraSchema = strictInput({
  directory: z.string().optional().describe("Root directory to scan."),
  skip_deps: z.boolean().default(false).describe("Skip dependency checks (faster, infra-only)."),
});

// ─── v3 Schemas ────────────────────────────────────────────────────────

export const CveSchema = strictInput({
  project: z.string().optional().describe("Check a specific project. Without it, pass `directory` or `all: true`."),
  directory: z.string().optional().describe("Root directory to scan."),
  all: z.boolean().default(false).describe(ALL_PROJECTS_HINT),
  show_db: z.boolean().default(false).describe("Show the full CVE advisory database."),
});

export const DeprecatedSchema = strictInput({
  project: z.string().optional().describe("Check a specific project. Without it, pass `directory` or `all: true`."),
  directory: z.string().optional().describe("Root directory to scan."),
  all: z.boolean().default(false).describe(ALL_PROJECTS_HINT),
});

export const SecretsSchema = strictInput({
  project: z.string().optional().describe("Scan a specific project. Without it, pass `directory` or `all: true`."),
  directory: z.string().optional().describe("Root directory to scan."),
  all: z.boolean().default(false).describe(ALL_PROJECTS_HINT),
});

export const LicensesSchema = strictInput({
  project: z.string().optional().describe("Check a specific project. Without it, pass `directory` or `all: true`."),
  directory: z.string().optional().describe("Root directory to scan."),
  all: z.boolean().default(false).describe(ALL_PROJECTS_HINT),
});

// ─── v4 Schemas ────────────────────────────────────────────────────────

export const LiveCveSchema = strictInput({
  project: z.string().optional().describe("Scan a specific project. Without it, pass `directory` or `all: true`."),
  directory: z.string().optional().describe("Root directory to scan."),
  all: z.boolean().default(false).describe(ALL_PROJECTS_HINT),
});

export const ChangelogSchema = strictInput({
  project: z.string().describe("Project name or path to check changelogs for."),
});

export const MigrateSchema = strictInput({
  project: z.string().optional().describe("Check a specific project. Without it, pass `directory` or `all: true`."),
  directory: z.string().optional().describe("Root directory to scan."),
  all: z.boolean().default(false).describe(ALL_PROJECTS_HINT),
});


// ─── v4.1 Context/Docs Schemas ─────────────────────────────────────────

export const DocsSchema = strictInput({
  package: z.string().describe("Package name to fetch docs for (e.g. 'svelte', '@supabase/supabase-js', 'tailwindcss')."),
  query: z.string().optional().describe("Optional: specific question or topic to focus docs on (e.g. 'runes migration', 'auth setup', 'streaming')."),
  sections: z.enum(["all", "readme", "changelog", "migration"]).optional().describe("Which sections to fetch: 'all' (default), 'readme', 'changelog', or 'migration'."),
});

export const SearchPackageSchema = strictInput({
  query: z.string().describe("Search query to find packages (e.g. 'svelte auth', 'stripe payment', 'tailwind merge')."),
});
