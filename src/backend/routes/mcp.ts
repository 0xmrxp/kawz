// MCP Server — exposes all 15 endpoints as tools over Streamable HTTP Transport.
// Per-request instantiation is required for stateless VPS deployments.
// Phase 7 will register all 15 tools.

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import type { Variables } from "../types";

const mcp = new Hono<{ Variables: Variables }>();

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "lobre", version: "1.0.0" });
  // Phase 7: register all 15 tools here, sharing the same helper functions as the REST routes.
  return server;
}

mcp.all("/", async (c) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

export default mcp;
