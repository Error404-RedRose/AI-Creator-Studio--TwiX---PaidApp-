#!/usr/bin/env node
/**
 * TwiX scene MCP server.
 *
 * Runs as a local stdio MCP server spawned by OpenCode. Every tool call is
 * forwarded over HTTP to the TwiX desktop bridge, which executes it against the
 * live Three.js scene in the connected workspace and returns a structured result.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { tools } from "../shared/tools.mjs";

const BRIDGE_URL = process.env.TWIX_BRIDGE_URL || "http://127.0.0.1:4317";
const BRIDGE_TOKEN = process.env.TWIX_BRIDGE_TOKEN || "";
const PROJECT_ID = process.env.TWIX_PROJECT_ID || "";

const server = new Server(
  {
    name: "twix-scene",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Unknown TwiX tool: ${name}` }) }],
      isError: true,
    };
  }
  if (!BRIDGE_TOKEN || !PROJECT_ID) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: false, error: "TwiX bridge is not configured for this workspace." }),
        },
      ],
      isError: true,
    };
  }

  try {
    const res = await fetch(`${BRIDGE_URL}/api/bridge/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: BRIDGE_TOKEN,
        projectId: PROJECT_ID,
        name,
        args: args || {},
      }),
      signal: AbortSignal.timeout(310000),
    });
    const text = await res.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      result = { ok: false, error: `Bridge returned invalid JSON (HTTP ${res.status})`, raw: text.slice(0, 500) };
    }
    const payload = JSON.stringify(result);
    return {
      content: [{ type: "text", text: payload }],
      structuredContent: result,
      isError: result?.ok === false,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            error: `TwiX bridge unreachable: ${error.message}. Is the TwiX app open on this project?`,
          }),
        },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
