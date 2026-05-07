import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from "zod";
import { createClient } from '@neondatabase/neon-js';
import type { Database } from './types/database.types';
import { ZodMiniE164 } from 'zod/mini';

const getServer = () => {
    // Create an MCP server with implementation details
    const server = new McpServer(
        {
            name: 'umfragen-datenbank-mcp-server',
            version: '1.0.0'
        },
        { capabilities: { logging: {} } }
    );

  server.registerTool(
    'get-question',
    {
      description: "Hole dir eine spezifische Frage aus einer Umfrage",
      inputSchema: {
        questionNumber: z.number().describe("die wievielte Frage das aus der Umfrage ist"),
        UmfrageID: z.number().describe("die ID der Umfrage die aktuell gemacht wird")
      }
    },
    async ({ questionNumber, UmfrageID }, extra) => {
      questionNumber = 14
      UmfrageID = 10
    }
)
)
