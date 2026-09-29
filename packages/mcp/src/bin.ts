#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './index.js';

// stdout carries the MCP protocol, so diagnostics must go to stderr.
const server = createServer();
await server.connect(new StdioServerTransport());
console.error('costtrace MCP server running on stdio');
