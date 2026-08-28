// Minimal MCP server for tests: one echo tool over stdio.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'mock', version: '1.0.0' });
server.tool('echo', 'Echo the given text back.', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text: `echo: ${text}` }],
}));
process.stderr.write('mock-mcp-server started\n');
await server.connect(new StdioServerTransport());
