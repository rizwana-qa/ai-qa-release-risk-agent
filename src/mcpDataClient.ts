/**
 * Thin MCP data client: retrieves the four synthetic datasets by calling the
 * Phase 4 MCP server's read-only tools over stdio.
 *
 * This is transport plumbing only — it contains no QA logic and no release
 * decision logic. It exists so the Phase 6 orchestration (and the n8n workflow)
 * can gather context "through the existing MCP layer" rather than reading files
 * directly.
 */

import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface FetchedDatasets {
  requirement: unknown;
  existingTests: unknown;
  knownDefects: unknown;
  riskRules: unknown;
}

const TOOL_TO_KEY: Record<string, keyof FetchedDatasets> = {
  get_requirement: "requirement",
  get_existing_tests: "existingTests",
  get_known_defects: "knownDefects",
  get_risk_rules: "riskRules",
};

function textOf(result: unknown): string {
  const blocks = (result as { content?: Array<Record<string, unknown>> }).content ?? [];
  const first = blocks.find((b) => b.type === "text" && typeof b.text === "string");
  if (!first) throw new Error("MCP tool returned no text content block.");
  return first.text as string;
}

/** Connect to the Phase 4 MCP server, call all four tools, return their parsed output. */
export async function fetchDatasetsViaMcp(): Promise<FetchedDatasets> {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["src/mcpServer.ts"],
    cwd: PROJECT_ROOT,
  });
  const client = new Client({ name: "pipeline-mcp-data-client", version: "0.1.0" });
  await client.connect(transport);

  try {
    const out: Partial<FetchedDatasets> = {};
    for (const [tool, key] of Object.entries(TOOL_TO_KEY)) {
      const result = await client.callTool({ name: tool, arguments: {} });
      out[key] = JSON.parse(textOf(result)) as unknown;
    }
    return out as FetchedDatasets;
  } finally {
    await client.close();
  }
}
