// Run with: npm test (builds first, then tests dist/)
// MCP instructions: sent to every client in the initialize result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SERVER_INSTRUCTIONS } from "../dist/constants.js";

const serverEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

test("the server sends its instructions at connection", async () => {
  const home = mkdtempSync(join(tmpdir(), "depsonar-instructions-"));
  const client = new Client({ name: "depsonar-instructions-test", version: "1.0.0" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [serverEntry],
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stderr: "pipe",
      })
    );
    const instructions = client.getInstructions();
    assert.equal(instructions, SERVER_INSTRUCTIONS);
    assert.match(instructions, /depsonar_alerts/);
    assert.match(instructions, /dry_run: true first/);
    assert.match(instructions, /never try to print a full secret/);
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
});
