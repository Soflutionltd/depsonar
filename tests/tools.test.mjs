// Run with: npm test (builds first, then tests dist/)
// The tools as an MCP client sees them: argument names and scan scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

// A home of its own: the projects directory holds one clean project, nothing of the user's.
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "depsonar-tools-"));
  const projects = join(home, "projects");
  const app = join(projects, "app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app", version: "1.0.0", license: "MIT" }));
  writeFileSync(join(home, ".depsonarrc.json"), JSON.stringify({ projectsDir: projects }));
  return { home, projects, app };
}

async function connect(home) {
  const client = new Client({ name: "depsonar-tools-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stderr: "pipe",
    })
  );
  return client;
}

const scopedTools = [
  "depsonar_actions",
  "depsonar_docker",
  "depsonar_envcheck",
  "depsonar_audit",
  "depsonar_cve",
  "depsonar_deprecated",
  "depsonar_secrets",
  "depsonar_licenses",
  "depsonar_live_cve",
  "depsonar_migrate",
];

// A refused call comes back either as a thrown protocol error or as an error result.
async function refusal(client, name, args) {
  try {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name} accepted ${JSON.stringify(args)}`);
    return result.content[0].text;
  } catch (thrown) {
    return thrown.message;
  }
}

test("an argument the tool does not declare is refused, never dropped", async (t) => {
  const { home, app } = sandbox();
  const client = await connect(home);
  t.after(async () => {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  });

  const listed = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of scopedTools) assert.ok(listed.includes(name), `${name} is registered`);

  for (const name of ["depsonar_audit", "depsonar_secrets", "depsonar_licenses", "depsonar_check"]) {
    assert.match(await refusal(client, name, { path: app }), /Unrecognized key.*path/s, name);
  }
});

test("a call that names no project, no directory and not all scans nothing", async (t) => {
  const { home, app, projects } = sandbox();
  const client = await connect(home);
  t.after(async () => {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  });

  for (const name of scopedTools) {
    assert.match(await refusal(client, name, {}), /No scope given.*`all: true`/s, name);
  }

  const call = async (args) => {
    const result = await client.callTool({ name: "depsonar_secrets", arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(args));
    return result.content[0].text;
  };
  for (const args of [{ project: app }, { project: "app" }, { directory: projects }, { all: true }]) {
    assert.doesNotMatch(await call(args), /No scope given/, JSON.stringify(args));
  }
});
