import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/server";
import type { Request, Response } from "express";
import * as z from "zod";
import { neon } from "@neondatabase/serverless";

// Initialisiere die DB-Verbindung außerhalb, damit der Connection-Pool
// über verschiedene Requests hinweg erhalten bleibt.
const sql = neon(process.env.DATABASE_URL!);

const getServer = () => {
  // Create an MCP server with implementation details
  const server = new McpServer(
    {
      name: "umfragify-mcp-server",
      version: "1.0.0",
    },
    { capabilities: { logging: {} } },
  );

  // Register the Umfragify Tool
  server.registerTool(
    "get-question",
    {
      description:
        "Holt eine spezifische Frage anhand ihrer Reihenfolge und liefert direkt alle bisherigen Antwort-Kategorien als Array mit.",
      inputSchema: z.object({
        surveyId: z.number().describe("Die ID der Umfrage"),
        questionNumber: z
          .number()
          .describe(
            "Die wievielte Frage das aus der Umfrage ist (sequence_number)",
          ),
      }),
    },
    async ({ surveyId, questionNumber }): Promise<CallToolResult> => {
      try {
        const result = await sql`
                    SELECT
                        q.id,
                        q.text,
                        q.sequence_number,
                        COALESCE(
                            json_agg(
                                json_build_object('id', c.id, 'label', c.label, 'counter', c.counter)
                            ) FILTER (WHERE c.id IS NOT NULL),
                            '[]'
                        ) as existing_categories
                    FROM questions q
                    LEFT JOIN categories c ON q.id = c.question_id
                    WHERE q.survey_id = ${surveyId} AND q.sequence_number = ${questionNumber}
                    GROUP BY q.id
                    LIMIT 1
                `;

        if (result.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "end_of_survey",
                  message:
                    "Keine weitere Frage gefunden. Die Umfrage ist abgeschlossen.",
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  question: {
                    id: result[0].id,
                    text: result[0].text,
                    sequence_number: result[0].sequence_number,
                  },
                  existing_categories: result[0].existing_categories,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        console.error("Datenbankfehler:", error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Fehler beim Abrufen der Frage: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  return server;
};

// Nutze die offizielle Factory-Funktion für die Express App
const app = createMcpExpressApp();

app.post("/mcp", async (req: Request, res: Response) => {
  const server = getServer();
  try {
    const transport: NodeStreamableHTTPServerTransport =
      new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    res.on("close", () => {
      console.log("Request closed");
      transport.close();
      server.close();
    });
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32_603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

app.get("/mcp", async (req: Request, res: Response) => {
  console.log("Received GET MCP request");
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32_000,
        message: "Method not allowed.",
      },
      id: null,
    }),
  );
});

app.delete("/mcp", async (req: Request, res: Response) => {
  console.log("Received DELETE MCP request");
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32_000,
        message: "Method not allowed.",
      },
      id: null,
    }),
  );
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, (error) => {
  if (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
  console.log(
    `🚀 Umfragify Stateless Streamable HTTP Server listening on port ${PORT}`,
  );
});

// Handle server shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down server...");
  process.exit(0);
});
