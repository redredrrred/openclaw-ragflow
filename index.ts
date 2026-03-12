/**
 * RAGFlow Knowledge Base Plugin for OpenClaw
 *
 * Integrates RAGFlow knowledge bases with OpenClaw's AI agent.
 * Provides intelligent document retrieval and auto-context injection.
 *
 * Features:
 * - Search knowledge bases via tools
 * - Auto-inject relevant context into conversations
 * - List and manage datasets
 * - Support for multiple knowledge bases
 * - Production-ready with retry logic and graceful degradation
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ============================================================================
// Constants
// ============================================================================

const MAX_INJECT_CHARS = 2000; // Maximum characters for auto-injected context
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

// ============================================================================
// Types
// ============================================================================

interface RAGFlowConfig {
  apiUrl: string;
  apiKey: string;
  datasetIds?: string[];
  autoInject?: boolean;
  similarityThreshold?: number;
  topK?: number;
  maxInjectChars?: number; // Maximum characters for auto-injection
}

interface RAGFlowChunk {
  chunk_id: string;
  content: string;
  similarity: number;
  document_keyword: string;
  dataset_id?: string;
}

interface RAGFlowRetrievalResponse {
  code: number;
  data: {
    chunks: RAGFlowChunk[];
  };
}

interface RAGFlowDataset {
  id: string;
  name: string;
  description: string;
  chunk_num: number;
  created_at: string;
}

interface RAGFlowDatasetResponse {
  code: number;
  data: RAGFlowDataset[];
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number = MAX_RETRY_ATTEMPTS,
  baseDelay: number = RETRY_DELAY_MS,
  logger?: { warn: (msg: string) => void; info: (msg: string) => void },
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxAttempts) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        logger?.warn(
          `Attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms: ${lastError.message}`,
        );
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

// ============================================================================
// RAGFlow API Client
// ============================================================================

class RAGFlowClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private healthy: boolean = true;
  private consecutiveErrors: number = 0;
  private lastErrorTime: number = 0;
  private readonly COOLDOWN_MS = 60000; // 1 minute cooldown after errors

  constructor(
    private config: RAGFlowConfig,
    private logger?: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
    },
  ) {
    // Remove trailing slash from URL
    this.baseUrl = config.apiUrl.replace(/\/$/, "");
    this.headers = {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Check if the client is healthy (not in cooldown)
   */
  private isHealthy(): boolean {
    if (!this.healthy) {
      const timeSinceLastError = Date.now() - this.lastErrorTime;
      if (timeSinceLastError > this.COOLDOWN_MS) {
        // Cooldown period over, reset health
        this.healthy = true;
        this.consecutiveErrors = 0;
        this.logger?.info("ragflow-knowledge: client recovered from cooldown");
      } else {
        return false;
      }
    }
    return true;
  }

  /**
   * Mark the client as unhealthy after an error
   */
  private markError(error: Error): void {
    this.consecutiveErrors++;
    this.lastErrorTime = Date.now();

    // Enter cooldown after 3 consecutive errors
    if (this.consecutiveErrors >= 3) {
      this.healthy = false;
      this.logger?.warn(
        `ragflow-knowledge: entering cooldown after ${this.consecutiveErrors} consecutive errors`,
      );
    }
  }

  /**
   * Search knowledge base for relevant chunks with retry
   */
  async search(params: {
    question: string;
    datasetIds?: string[];
    similarityThreshold?: number;
    topK?: number;
  }): Promise<RAGFlowChunk[]> {
    // Skip if in cooldown
    if (!this.isHealthy()) {
      this.logger?.warn(
        "ragflow-knowledge: client in cooldown, skipping search",
      );
      return [];
    }

    const {
      question,
      datasetIds,
      similarityThreshold,
      topK,
    } = params;

    const requestBody: Record<string, unknown> = {
      question,
    };

    // Only include dataset_ids if specified
    if (datasetIds && datasetIds.length > 0) {
      requestBody.dataset_ids = datasetIds;
    }

    // Only include similarity_threshold if explicitly configured
    if (similarityThreshold !== undefined) {
      requestBody.similarity_threshold = similarityThreshold;
    }

    // Only include top_k if explicitly configured
    if (topK !== undefined) {
      requestBody.top_k = topK;
    }

    try {
      const chunks = await retryWithBackoff(async () => {
        const response = await fetch(`${this.baseUrl}/api/v1/retrieval`, {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `RAGFlow API error (${response.status}): ${errorText}`,
          );
        }

        const result = (await response.json()) as RAGFlowRetrievalResponse;

        if (result.code !== 0) {
          throw new Error(`RAGFlow retrieval failed: code ${result.code}`);
        }

        return result.data?.chunks || [];
      });

      // Reset error count on success
      this.consecutiveErrors = 0;
      return chunks;
    } catch (error) {
      this.markError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Test API connection (called at startup)
   */
  async testConnection(): Promise<boolean> {
    try {
      await retryWithBackoff(async () => {
        const response = await fetch(`${this.baseUrl}/api/v1/datasets`, {
          method: "GET",
          headers: this.headers,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
      }, 2, RETRY_DELAY_MS, this.logger);

      this.logger?.info("ragflow-knowledge: API connection test successful");
      return true;
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      this.logger?.error(
        `ragflow-knowledge: connection test failed: ${errorMsg}`,
      );
      throw error;
    }
  }

  /**
   * List all available datasets
   */
  async listDatasets(): Promise<RAGFlowDataset[]> {
    if (!this.isHealthy()) {
      throw new Error("Client in cooldown, please try again later");
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/v1/datasets`, {
        method: "GET",
        headers: this.headers,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `RAGFlow API error (${response.status}): ${errorText}`,
        );
      }

      const result = (await response.json()) as RAGFlowDatasetResponse;

      if (result.code !== 0) {
        throw new Error(`RAGFlow dataset list failed: code ${result.code}`);
      }

      return result.data || [];
    } catch (error) {
      this.markError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Get dataset by name
   */
  async getDatasetByName(name: string): Promise<RAGFlowDataset | null> {
    const datasets = await this.listDatasets();
    return datasets.find((d) => d.name === name) || null;
  }

  /**
   * Get the configuration
   */
  getConfig(): RAGFlowConfig {
    return this.config;
  }

  /**
   * Get health status
   */
  getHealthStatus(): { healthy: boolean; consecutiveErrors: number } {
    return {
      healthy: this.healthy && this.consecutiveErrors < 3,
      consecutiveErrors: this.consecutiveErrors,
    };
  }
}

// ============================================================================
// Configuration Schema
// ============================================================================

const ragflowConfigSchema = Type.Object({
  apiUrl: Type.String({
    description: "RAGFlow server URL",
  }),
  apiKey: Type.String({
    description: "RAGFlow API key",
  }),
  datasetIds: Type.Optional(
    Type.Array(Type.String(), {
      description: "Specific dataset IDs to search (empty = search all)",
    }),
  ),
  autoInject: Type.Optional(
    Type.Boolean({
      description: "Auto-inject relevant knowledge into conversations",
    }),
  ),
  similarityThreshold: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description: "Minimum similarity score (0-1)",
    }),
  ),
  topK: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 50,
      description: "Maximum chunks to retrieve",
    }),
  ),
  maxInjectChars: Type.Optional(
    Type.Number({
      minimum: 500,
      maximum: 10000,
      description: "Maximum characters for auto-injected context",
    }),
  ),
});

// ============================================================================
// Plugin Definition
// ============================================================================

const ragflowPlugin = {
  id: "ragflow-knowledge",
  name: "RAGFlow Knowledge Base",
  description: "RAGFlow-powered knowledge retrieval for OpenClaw",
  kind: "tool" as const,
  configSchema: ragflowConfigSchema,

  register(api: OpenClawPluginApi) {
    // Parse configuration with defaults
    const cfg: RAGFlowConfig = {
      apiUrl: (api.pluginConfig as Record<string, unknown>)
        .apiUrl as string,
      apiKey: (api.pluginConfig as Record<string, unknown>)
        .apiKey as string,
      datasetIds: (api.pluginConfig as Record<string, unknown>)
        .datasetIds as string[],
      autoInject: ((api.pluginConfig as Record<string, unknown>)
        .autoInject as boolean) ?? true,
      similarityThreshold: (api.pluginConfig as Record<string, unknown>)
        .similarityThreshold as number | undefined,
      topK: (api.pluginConfig as Record<string, unknown>)
        .topK as number | undefined,
      maxInjectChars: ((api.pluginConfig as Record<string, unknown>)
        .maxInjectChars as number) ?? MAX_INJECT_CHARS,
    };

    // Initialize RAGFlow client
    const client = new RAGFlowClient(cfg, api.logger);

    api.logger.info(
      `ragflow-knowledge: initialized (API: ${cfg.apiUrl}, datasets: ${cfg.datasetIds?.length || 0}, auto-inject: ${cfg.autoInject})`,
    );

    // ========================================================================
    // Tools
    // ========================================================================

    /**
     * Tool: Search knowledge base
     */
    api.registerTool(
      {
        name: "ragflow_search",
        label: "Search Knowledge Base",
        description:
          "Search the RAGFlow knowledge base for relevant information. Use when you need to answer questions based on company documents, product manuals, or any stored knowledge.",
        parameters: Type.Object({
          query: Type.String({
            description: "Search query or question",
          }),
          topK: Type.Optional(
            Type.Number({
              description: "Maximum number of results to return",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { query, topK } = params as { query: string; topK?: number };

          try {
            const chunks = await client.search({
              question: query,
              datasetIds: cfg.datasetIds,
              similarityThreshold: cfg.similarityThreshold,
              topK: topK ?? cfg.topK,
            });

            if (chunks.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "No relevant information found in the knowledge base.",
                  },
                ],
              };
            }

            // Format results
            const results = chunks
              .map(
                (chunk, index) =>
                  `${index + 1}. [${chunk.document_keyword}] (相似度: ${(
                    chunk.similarity * 100
                  ).toFixed(1)}%)\n${chunk.content}`,
              )
              .join("\n\n---\n\n");

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${chunks.length} relevant result(s) from the knowledge base:\n\n${results}`,
                },
              ],
              details: {
                count: chunks.length,
                chunks: chunks.map((c) => ({
                  id: c.chunk_id,
                  document: c.document_keyword,
                  similarity: c.similarity,
                  content: c.content.slice(0, 200),
                })),
              },
            };
          } catch (error) {
            api.logger.error(`ragflow_search failed: ${error}`);
            return {
              content: [
                {
                  type: "text",
                  text: `Error searching knowledge base: ${error}`,
                },
              ],
            };
          }
        },
      },
      { name: "ragflow_search" },
    );

    /**
     * Tool: List datasets
     */
    api.registerTool(
      {
        name: "ragflow_list_datasets",
        label: "List Knowledge Bases",
        description:
          "List all available knowledge bases/datasets in RAGFlow. Use this to see what knowledge bases are available.",
        parameters: Type.Object({}),
        async execute(_toolCallId) {
          try {
            const datasets = await client.listDatasets();

            if (datasets.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: "No knowledge bases found in RAGFlow.",
                  },
                ],
              };
            }

            const list = datasets
              .map(
                (d) =>
                  `- **${d.name}** (ID: ${d.id})\n  ${
                    d.description || "No description"
                  }\n  Documents: ${d.chunk_num} chunks`,
              )
              .join("\n\n");

            return {
              content: [
                {
                  type: "text",
                  text: `Available knowledge bases (${datasets.length}):\n\n${list}`,
                },
              ],
              details: {
                count: datasets.length,
                datasets: datasets.map((d) => ({
                  id: d.id,
                  name: d.name,
                  description: d.description,
                  chunkNum: d.chunk_num,
                })),
              },
            };
          } catch (error) {
            api.logger.error(`ragflow_list_datasets failed: ${error}`);
            return {
              content: [
                {
                  type: "text",
                  text: `Error listing knowledge bases: ${error}`,
                },
              ],
            };
          }
        },
      },
      { name: "ragflow_list_datasets" },
    );

    /**
     * Tool: Check plugin health status
     */
    api.registerTool(
      {
        name: "ragflow_health",
        label: "Check RAGFlow Health",
        description:
          "Check the health status of the RAGFlow connection. Returns whether the service is healthy and any recent error information.",
        parameters: Type.Object({}),
        async execute(_toolCallId) {
          const health = client.getHealthStatus();
          return {
            content: [
              {
                type: "text",
                text: `RAGFlow Plugin Status:\n${
                  health.healthy
                    ? "✅ Healthy"
                    : "⚠️ In cooldown (too many errors)"
                }\nConsecutive errors: ${health.consecutiveErrors}`,
              },
            ],
          };
        },
      },
      { name: "ragflow_health" },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const ragflow = program
          .command("ragflow")
          .description("RAGFlow knowledge base commands");

        ragflow
          .command("search")
          .description("Search knowledge base")
          .argument("<query>", "Search query")
          .option("-k, --top-k <n>", "Max results", "5")
          .action(async (query, opts) => {
            try {
              const chunks = await client.search({
                question: query,
                datasetIds: cfg.datasetIds,
                similarityThreshold: cfg.similarityThreshold,
                topK: Number.parseInt(opts.topK),
              });

              console.log(`\nFound ${chunks.length} result(s):\n`);
              chunks.forEach((chunk, index) => {
                console.log(
                  `${index + 1}. [${chunk.document_keyword}] (${(
                    chunk.similarity * 100
                  ).toFixed(1)}%)`,
                );
                console.log(`${chunk.content}\n`);
              });
            } catch (error) {
              console.error(`Error: ${error}`);
              process.exit(1);
            }
          });

        ragflow
          .command("datasets")
          .description("List all knowledge bases")
          .action(async () => {
            try {
              const datasets = await client.listDatasets();
              console.log(
                `\nAvailable knowledge bases (${datasets.length}):\n`,
              );
              datasets.forEach((d) => {
                console.log(`- ${d.name} (${d.id})`);
                console.log(`  ${d.description || "No description"}`);
                console.log(`  Chunks: ${d.chunk_num}\n`);
              });
            } catch (error) {
              console.error(`Error: ${error}`);
              process.exit(1);
            }
          });

        ragflow
          .command("health")
          .description("Check RAGFlow connection health")
          .action(async () => {
            const health = client.getHealthStatus();
            console.log(
              `\nRAGFlow Plugin Status:\n${
                health.healthy
                  ? "✅ Healthy"
                  : "⚠️ In cooldown (too many errors)"
              }\nConsecutive errors: ${health.consecutiveErrors}\n`,
            );
          });
      },
      { commands: ["ragflow"] },
    );

    // ========================================================================
    // Lifecycle Hooks (Auto-inject context)
    // ========================================================================

    if (cfg.autoInject) {
      api.on("before_agent_start", async (event) => {
        // Skip if prompt is too short
        if (!event.prompt || event.prompt.length < 10) {
          return;
        }

        try {
          // Search for relevant knowledge
          const chunks = await client.search({
            question: event.prompt,
            datasetIds: cfg.datasetIds,
            similarityThreshold: cfg.similarityThreshold,
            topK: cfg.topK,
          });

          // Skip if no relevant chunks found
          if (chunks.length === 0) {
            return;
          }

          // Truncate content to fit within maxInjectChars
          let totalChars = 0;
          const truncatedChunks: string[] = [];

          for (const chunk of chunks) {
            const chunkText = `[${chunk.document_keyword}] ${chunk.content}`;
            if (totalChars + chunkText.length > cfg.maxInjectChars!) {
              // Only add a partial chunk if there's room
              const remaining = cfg.maxInjectChars! - totalChars;
              if (remaining > 100) {
                // Only add if there's at least 100 chars remaining
                truncatedChunks.push(
                  `${chunkText.slice(0, remaining)}... [truncated]`,
                );
              }
              break;
            }
            truncatedChunks.push(chunkText);
            totalChars += chunkText.length;
          }

          if (truncatedChunks.length === 0) {
            return;
          }

          api.logger.info(
            `ragflow-knowledge: injecting ${truncatedChunks.length} chunks (${totalChars} chars) into context`,
          );

          // Format context for injection - use a more concise format
          const context = truncatedChunks.join("\n\n---\n\n");

          // Return a more compact, user-friendly format
          return {
            prependContext: `📚 [知识库参考]\n${context}\n---\n`,
          };
        } catch (err) {
          // Silently fail for auto-inject to avoid disrupting user experience
          api.logger.warn(
            `ragflow-knowledge: auto-inject failed: ${String(err)}`,
          );
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "ragflow-knowledge",
      start: async () => {
        // Test API connection at startup with retry
        try {
          await client.testConnection();
          api.logger.info(
            `ragflow-knowledge: started successfully (API: ${cfg.apiUrl}, auto-inject: ${cfg.autoInject}, max inject: ${cfg.maxInjectChars} chars)`,
          );
        } catch (error) {
          api.logger.error(
            `ragflow-knowledge: failed to connect to RAGFlow API after retries: ${error}`,
          );
          api.logger.warn(
            "ragflow-knowledge: plugin started in degraded mode - tools will attempt reconnection",
          );
          // Don't throw - allow plugin to start in degraded mode
        }
      },
      stop: () => {
        api.logger.info("ragflow-knowledge: stopped");
      },
    });
  },
};

export default ragflowPlugin;