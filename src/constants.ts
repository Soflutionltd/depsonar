export const SERVER_NAME = "depsonar";
export const SERVER_VERSION = "4.1.0";

/**
 * Sent to every MCP client in the initialize result, so any agent knows how to use the server
 * without extra setup.
 */
export const SERVER_INSTRUCTIONS = [
  "depsonar audits and updates the dependencies of local code projects (Node, Python, Rust, Go, PHP, Ruby, Dart, Swift, Kotlin): outdated packages, CVEs, deprecated packages, secrets, licenses, runtimes, Docker images, GitHub Actions. It does not build, deploy or publish anything.",
  "Start with depsonar_alerts (instant, reads the last background scan), then depsonar_check on the project, then depsonar_audit or depsonar_live_cve, depsonar_secrets and depsonar_licenses. Before a major update, read depsonar_changelog and depsonar_migrate.",
  "Most scan tools require a scope: ask the user which project (name or absolute path) unless the current folder makes it obvious; use all: true only when they ask for every project. depsonar_scan lists the projects.",
  "depsonar_update writes to the project as soon as it is called (dry_run defaults to false): call it with dry_run: true first, show the preview, and apply only after the user agrees. depsonar_update_all defaults to a preview: never set dry_run: false without the user's go-ahead. Ask before depsonar_install with clean: true (it deletes node_modules or vendor) and before changing depsonar_setup_checker or depsonar_config.",
  "depsonar_secrets returns masked previews: never try to print a full secret value, report the file and line instead.",
  "A failed call returns isError with a message starting with \"Error:\": quote it, fix the argument it names (scope, project name), and do not retry the same call unchanged.",
].join("\n");

export const CHARACTER_LIMIT = 25_000;
export const COMMAND_TIMEOUT = 120_000;

// ─── Ecosystem Grouping (for display) ──────────────────────────────────

export const ECOSYSTEM_GROUPS: Record<string, RegExp> = {
  svelte: /^(svelte|@sveltejs\/|svelte-check|svelte-preprocess)/,
  react: /^(react|react-dom|@types\/react|next|@next\/)/,
  vue: /^(vue|@vue\/|nuxt|@nuxt\/|vite-plugin-vue)/,
  supabase: /^@supabase\//,
  tailwind: /^(tailwindcss|@tailwindcss\/|postcss|autoprefixer)/,
  vite: /^(vite|@vitejs\/|rollup|@rollup\/)/,
  typescript: /^(typescript|tslib|ts-node|@types\/node)/,
  eslint: /^(eslint|@eslint\/|@typescript-eslint\/|prettier)/,
  stripe: /^(stripe|@stripe\/)/,
  testing: /^(vitest|@testing-library\/|playwright|@playwright\/)/,
};

// ─── Framework Detection ───────────────────────────────────────────────

export const FRAMEWORK_DETECTORS: Record<string, string[]> = {
  SvelteKit: ["svelte.config.js", "svelte.config.ts"],
  "Next.js": ["next.config.js", "next.config.ts", "next.config.mjs"],
  Nuxt: ["nuxt.config.ts", "nuxt.config.js"],
  Astro: ["astro.config.mjs", "astro.config.ts"],
  Remix: ["remix.config.js", "remix.config.ts"],
  SolidStart: ["app.config.ts", "app.config.js"],
  Django: ["manage.py"],
  Flask: ["wsgi.py"],
  Laravel: ["artisan"],
  "Xcode/Swift": ["*.xcodeproj", "*.xcworkspace"],
  "Android/Kotlin": ["settings.gradle.kts", "settings.gradle"],
};

// ─── Language Detection ────────────────────────────────────────────────

export interface LanguageMarker {
  files: string[];
  name: string;
  outdatedCmd: string;
  updateCmd: string;
  updateLatestCmd: string;
  installCmd: string;
  cleanCmd: string;
  auditCmd: string | null;
  parseOutdated: "npm" | "pip" | "cargo" | "go" | "composer" | "gem" | "pub" | "swift" | "gradle";
}

export const LANGUAGE_MARKERS: Record<string, LanguageMarker> = {
  node: {
    files: ["package.json"],
    name: "Node.js",
    outdatedCmd: "{pm} outdated --json",
    updateCmd: "{pm} update",
    updateLatestCmd: "{pm} update --latest",
    installCmd: "{pm} install",
    cleanCmd: "rm -rf node_modules",
    auditCmd: "{pm} audit --json",
    parseOutdated: "npm",
  },
  python: {
    files: ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py"],
    name: "Python",
    outdatedCmd: "pip list --outdated --format=json",
    updateCmd: "pip install --upgrade {packages}",
    updateLatestCmd: "pip install --upgrade {packages}",
    installCmd: "pip install -r requirements.txt",
    cleanCmd: "",
    auditCmd: "pip audit --format=json",
    parseOutdated: "pip",
  },
  rust: {
    files: ["Cargo.toml"],
    name: "Rust",
    outdatedCmd: "cargo outdated --format json",
    updateCmd: "cargo update",
    updateLatestCmd: "cargo update",
    installCmd: "cargo build",
    cleanCmd: "cargo clean",
    auditCmd: "cargo audit --json",
    parseOutdated: "cargo",
  },
  go: {
    files: ["go.mod"],
    name: "Go",
    outdatedCmd: "go list -m -u -json all",
    updateCmd: "go get -u ./...",
    updateLatestCmd: "go get -u ./...",
    installCmd: "go mod download",
    cleanCmd: "go clean -modcache",
    auditCmd: "govulncheck -json ./...",
    parseOutdated: "go",
  },
  php: {
    files: ["composer.json"],
    name: "PHP",
    outdatedCmd: "composer outdated --format=json",
    updateCmd: "composer update",
    updateLatestCmd: "composer update --with-all-dependencies",
    installCmd: "composer install",
    cleanCmd: "rm -rf vendor",
    auditCmd: "composer audit --format=json",
    parseOutdated: "composer",
  },
  ruby: {
    files: ["Gemfile"],
    name: "Ruby",
    outdatedCmd: "bundle outdated --parseable",
    updateCmd: "bundle update",
    updateLatestCmd: "bundle update",
    installCmd: "bundle install",
    cleanCmd: "rm -rf vendor/bundle",
    auditCmd: "bundle-audit check --format json",
    parseOutdated: "gem",
  },
  dart: {
    files: ["pubspec.yaml"],
    name: "Dart/Flutter",
    outdatedCmd: "dart pub outdated --json",
    updateCmd: "dart pub upgrade",
    updateLatestCmd: "dart pub upgrade --major-versions",
    installCmd: "dart pub get",
    cleanCmd: "rm -rf .dart_tool",
    auditCmd: null,
    parseOutdated: "pub",
  },
  swift: {
    files: ["Package.swift"],
    name: "Swift",
    outdatedCmd: "swift package show-dependencies --format json",
    updateCmd: "swift package update",
    updateLatestCmd: "swift package update",
    installCmd: "swift package resolve",
    cleanCmd: "swift package clean",
    auditCmd: null,
    parseOutdated: "swift",
  },
  kotlin: {
    files: ["build.gradle.kts", "build.gradle"],
    name: "Kotlin/Java",
    outdatedCmd: "./gradlew dependencyUpdates -Drevision=release --output-formatter json",
    updateCmd: "./gradlew dependencyUpdates",
    updateLatestCmd: "./gradlew dependencyUpdates -Drevision=release",
    installCmd: "./gradlew build",
    cleanCmd: "./gradlew clean",
    auditCmd: null,
    parseOutdated: "gradle",
  },
};

// ─── Cache ─────────────────────────────────────────────────────────────

export const CACHE_FILENAME = ".depsonar-cache.json";
export const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours
