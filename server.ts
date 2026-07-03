import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/server";
import type { Request, Response } from "express";
import * as z from "zod";
import { neon } from "@neondatabase/serverless";
import { InferenceClient } from "@huggingface/inference";

// Initialisiere die DB-Verbindung außerhalb, damit der Connection-Pool
// über verschiedene Requests hinweg erhalten bleibt.
const sql = neon(process.env.DATABASE_URL!);
const hf = new InferenceClient(process.env.HF_TOKEN);

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
                        q.question_number,
                        COALESCE(
                            json_agg(
                                json_build_object('id', c.id, 'label', c.label, 'counter', c.counter)
                            ) FILTER (WHERE c.id IS NOT NULL),
                            '[]'
                        ) as existing_categories
                    FROM questions q
                    LEFT JOIN categories c ON q.id = c.question_id
                    WHERE q.survey_id = ${surveyId} AND q.question_number = ${questionNumber}
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
                    question_number: result[0].question_number,
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
  server.registerTool(
    "submit-answer",
    {
      description:
        "Erhöht den Zähler einer Antwort-Kategorie um 1. Erwartet wird die ID der Kategorie bzw. die IDs mehrerer Kategorien, falls mehrere passen sollten.",
      inputSchema: z.object({
        categoryIds: z
          .array(z.number())
          .describe("Ein Array von Kategorie-IDs, die erhöht werden sollen"),
      }),
    },
    async ({ categoryIds }): Promise<CallToolResult> => {
      try {
        await sql`
          UPDATE categories
          SET counter = counter + 1
          WHERE id = ANY(${categoryIds});
        `;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  message: `Zähler für Kategorie-IDs ${categoryIds.join(", ")} erfolgreich erhöht.`,
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
              text: `Fehler beim Aktualisieren der Kategorie-Zähler: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  )
  server.registerTool(
    "get-results",
    {
      description:
        "Gibt die aktuellen Ergebnisse der Umfrage zurück, also die Fragen mit den Antwort-Kategorien und deren Zählerständen.",
      inputSchema: z.object({
        surveyId: z.number().describe("Die ID der Umfrage"),
      }),
    },
    async ({ surveyId }): Promise<CallToolResult> => {
      try {
        const result = await sql`
          SELECT
            q.id,
            q.text,
            q.question_number,
            COALESCE(
              json_agg(
                json_build_object('id', c.id, 'label', c.label, 'counter', c.counter)
              ) FILTER (WHERE c.id IS NOT NULL),
              '[]'
            ) as categories
          FROM questions q
          LEFT JOIN categories c ON q.id = c.question_id
          WHERE q.survey_id = ${surveyId}
          GROUP BY q.id
          ORDER BY q.question_number;
        `;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  survey_results: result.map((q) => ({
                    id: q.id,
                    text: q.text,
                    question_number: q.question_number,
                    categories: q.categories,
                  })),
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
              text: `Fehler beim Abrufen der Umfrageergebnisse: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );
  server.registerTool(
    "add-category",
    {
      description:
        "Fügt eine neue Antwort-Kategorie zu einer Frage hinzu. Erwartet wird die ID der Frage, das Label der Kategorie und optional die initiale Anzahl des Zählers (Standard ist 1).",
      inputSchema: z.object({
        questionId: z.number().describe("Die ID der Frage, zu der die Kategorie hinzugefügt werden soll"),
        label: z.string().describe("Das Label der neuen Kategorie"),
        initialCounter: z.number().optional().describe("Der initiale Wert des Zählers (Standard ist 1). In dem allermeisten Fällen kannst du das ignorieren."),
      }),
    },
    async ({ questionId, label, initialCounter = 1 }): Promise<CallToolResult> => {
      try {
        const result = await sql`
          INSERT INTO categories (question_id, label, counter)
          VALUES (${questionId}, ${label}, ${initialCounter})
          RETURNING id;
        `;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  message: `Kategorie "${label}" erfolgreich hinzugefügt.`,
                  categoryId: result[0].id,
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
              text: `Fehler beim Hinzufügen der Kategorie: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  )
  server.registerTool(
    "sync-answer-analysis",
    {
      description: "Verarbeitet die KI-Analyse in einem einzigen Schritt: Erhöht bestehende Kategorien, legt neue an und loggt den Rohtext inklusive semantischem Vektor.",
      inputSchema: z.object({
        questionId: z.number().describe("Die ID der aktuellen Frage"),
        matchedCategoryIds: z.array(z.number()).default([]).describe("IDs bereits existierender Kategorien"),
        newCategoryLabels: z.array(z.string()).default([]).describe("Labels für komplett neue Kategorien"),
        rawResponse: z.string().describe("Der originale Text des Nutzers")
      })
    },
    async ({ questionId, matchedCategoryIds, newCategoryLabels, rawResponse }): Promise<CallToolResult> => {
      try {
        // 1. Vektor via Hugging Face API generieren
        // 1. Vektor via Hugging Face SDK (InferenceClient) generieren
        let embeddingVector: number[] | null = null;
        try {
          embeddingVector = (await hf.featureExtraction({
            model: "sentence-transformers/all-MiniLM-L6-v2",
            inputs: rawResponse,
          })) as number[];
        } catch (hfError) {
          console.error("Embedding-Generierung via SDK fehlgeschlagen:", hfError);
        }

        // 2. Transaktion an Neon DB senden
        await sql.transaction((tx) => {
          const queries = [];

          // Rohtext MIT Vektor loggen (falls Vektor-Generierung erfolgreich war)
          if (embeddingVector) {
            queries.push(
              tx`INSERT INTO raw_responses (question_id, text, embedding) VALUES (${questionId}, ${rawResponse}, ${JSON.stringify(embeddingVector)}::vector)`
            );
          } else {
            queries.push(
              tx`INSERT INTO raw_responses (question_id, text) VALUES (${questionId}, ${rawResponse})`
            );
          }

          // Bestehende inkrementieren
          if (matchedCategoryIds.length > 0) {
            queries.push(
              tx`UPDATE categories SET counter = counter + 1 WHERE id = ANY(${matchedCategoryIds})`
            );
          }

          // Neue Kategorien anlegen
          for (const label of newCategoryLabels) {
            queries.push(
              tx`
                INSERT INTO categories (question_id, label, counter)
                VALUES (${questionId}, ${label}, 1)
                ON CONFLICT (question_id, label) 
                DO UPDATE SET counter = categories.counter + 1
              `
            );
          }

          return queries;
        });

        return {
          content: [{ type: "text", text: JSON.stringify({ status: "success", message: "Analyse und Embedding erfolgreich synchronisiert." }, null, 2) }],
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: String(error) }] };
      }
    }
  );

  // DAS SEMANTISCHE SUCH-TOOL (sucht nach passenden Zitaten)
  server.registerTool(
    "search-raw-responses",
    {
      description: "Sucht nach semantisch ähnlichen Nutzerantworten (Zitaten) zu einer Frage anhand eines Text-Suchbegriffs.",
      inputSchema: z.object({
        questionId: z.number().describe("Die ID der Frage, zu der die Antworten durchsucht werden sollen"),
        searchQuery: z.string().describe("Der Textbegriff oder Satz, nach dem semantisch gesucht werden soll (z.B. 'Urlaub in der Karibik')"),
        limit: z.number().optional().default(5).describe("Maximale Anzahl an Zitaten"),
      }),
    },
    async ({ questionId, searchQuery, limit }): Promise<CallToolResult> => {
      try {
        // Suchbegriff in Vektor umwandeln via InferenceClient
        const queryEmbedding = (await hf.featureExtraction({
          model: "sentence-transformers/all-MiniLM-L6-v2",
          inputs: searchQuery,
        })) as number[];

        // Vektorsuche in Neon ausführen
        const result = await sql`
          SELECT id, text, (embedding <=> ${JSON.stringify(queryEmbedding)}::vector) as distance
          FROM raw_responses
          WHERE question_id = ${questionId} AND embedding IS NOT NULL
          ORDER BY distance ASC
          LIMIT ${limit};
        `;

        if (result.length === 0) {
          return {
            content: [{ type: "text", text: JSON.stringify({ status: "no_results", message: "Keine semantisch passenden Antworten gefunden." }) }],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "success",
                matches: result.map((r) => ({
                  id: r.id,
                  text: r.text,
                  similarityScore: (1 - r.distance).toFixed(4),
                })),
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `Fehler bei Vektorsuche: ${String(error)}` }] };
      }
    }
  );


  server.registerTool(
    "search-surveys",
    {
      description:
        "Sucht nach Umfragen (Surveys) anhand eines Textbegriffs im Namen/Titel und gibt die passenden IDs zurück.",
      inputSchema: z.object({
        searchTerm: z
          .string()
          .describe("Der Name oder ein Teil des Titels der Umfrage, nach der gesucht wird (z. B. 'Urlaub')"),
      }),
    },
    async ({ searchTerm }): Promise<CallToolResult> => {
      try {
        // %searchTerm% sorgt dafür, dass das Wort überall im Titel stehen kann
        const result = await sql`
        SELECT id, name
        FROM surveys
        WHERE name ILIKE ${'%' + searchTerm + '%'};
      `;

        if (result.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "no_results",
                  message: `Keine Umfrage mit dem Begriff "${searchTerm}" gefunden.`,
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
                  results: result.map((s) => ({
                    id: s.id,
                    name: s.name,
                  })),
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
              text: `Fehler bei der Umfragesuche: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  return server;
};

// Nutze die offizielle Factory-Funktion für die Express App
const app = createMcpExpressApp({
  allowedHosts: ["localhost", "umfragify-bot.onrender.com"]
});

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
