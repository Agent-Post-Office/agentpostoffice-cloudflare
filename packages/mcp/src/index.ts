#!/usr/bin/env node
import { AgentPostOfficeClient } from "@agentpostoffice/client";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentPostOfficeMcpServer } from "./server.js";

const baseUrl = process.env.AGENTPOSTOFFICE_URL;
const token = process.env.AGENTPOSTOFFICE_TOKEN;
if (!baseUrl || !token) {
  process.stderr.write("AGENTPOSTOFFICE_URL and AGENTPOSTOFFICE_TOKEN are required\n");
  process.exit(1);
}

const downloadDirectory = process.env.AGENTPOSTOFFICE_DOWNLOAD_DIR;
const server = createAgentPostOfficeMcpServer(
  new AgentPostOfficeClient({ baseUrl, token }),
  downloadDirectory ? { downloadDirectory } : {},
);
await server.connect(new StdioServerTransport());
