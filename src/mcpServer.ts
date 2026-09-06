/**
 * MCP server for the AI QA Release Risk & Test Strategy Agent (Version 1).
 *
 * Exposes four READ-ONLY, zero-parameter tools, each returning one synthetic
 * Phase 2 dataset verbatim:
 *
 *   get_requirement      -> data/requirement.json
 *   get_existing_tests   -> data/existing-tests.json
 *   get_known_defects    -> data/known-defects.json
 *   get_risk_rules       -> data/risk-rules.json
 *
 * Scope guardrails:
 *   - No release-decision logic here (that is the Phase 3 deterministic gate).
 *   - No AI / LLM, no n8n, no database, no network.
 *   - Tools take no arguments because Version 1 has exactly one scenario.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";

import { loadDataset, type DatasetName } from "./dataLoader.ts";

export const SERVER_NAME = "ai-qa-release-risk-agent";
export const SERVER_VERSION = "0.1.0";

interface ToolDefinition {
  name: string;
  description: string;
  dataset: DatasetName;
}

/** The four tools, declared as plain data so they are easy to read and test. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "get_requirement",
    description: "Return the synthetic requirement/spec for the single Version 1 change (REQ-BEN-001). Read-only, no parameters.",
    dataset: "requirement",
  },
  {
    name: "get_existing_tests",
    description: "Return the synthetic existing-test inventory and its acceptance-criterion coverage map. Read-only, no parameters.",
    dataset: "existing-tests",
  },
  {
    name: "get_known_defects",
    description: "Return the synthetic known-defect inventory. Read-only, no parameters.",
    dataset: "known-defects",
  },
  {
    name: "get_risk_rules",
    description: "Return the synthetic QA risk rules and deterministic release-gate rule set. Read-only, no parameters.",
    dataset: "risk-rules",
  },
];

const SERVER_INSTRUCTIONS = [
  "Read-only access to the synthetic QA dataset for one banking change (REQ-BEN-001):",
  '"Add a beneficiary and allow an authenticated customer to transfer money to the beneficiary after authentication."',
  "All data is synthetic. These tools only return data; they do not make or explain release decisions.",
].join(" ");

/**
 * Build (but do not start) the MCP server with all four tools registered.
 * Exported so tests can connect an in-memory client without spawning a process.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  for (const def of TOOL_DEFINITIONS) {
    server.registerTool(
      def.name,
      {
        title: def.name,
        description: def.description,
        // No `inputSchema`: the tool takes no arguments.
      },
      () => {
        const data = loadDataset(def.dataset);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      },
    );
  }

  return server;
}

/** Start the server on stdio. Used when this file is run directly. */
export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio transport keeps the process alive; nothing else to do here.
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error("[mcpServer] fatal:", err);
    process.exit(1);
  });
}
