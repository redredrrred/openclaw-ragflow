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
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

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
// RAGFlow API Client
// ============================================================================

class RAGFlowClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: RAGFlowConfig) {
    // Remove trailing slash from URL
    this.baseUrl = config.apiUrl.replace(/\/$/, "");
    this.headers = {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Search knowledge base for relevant chunks
   */
  async search(params: {
    question: string;
    datasetIds?: string[];
    similarityThreshold?: number;
    topK?: number;
  }): Promise<RAGFlowChunk[]> {
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
  }

  /**
   * Test API connection (called at startup)
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/datasets`, {
        method: "GET",
        headers: this.headers,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return true;
    } catch (error) {
      throw new Error(
        `RAGFlow connection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * List all available datasets
   */
  async listDatasets(): Promise<RAGFlowDataset[]> {
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
  }

  /**
   * Get dataset by name
   */
  async getDatasetByName(name: string): Promise<RAGFlowDataset | null> {
    const datasets = await this.listDatasets();
    return datasets.find((d) => d.name === name) || null;
  }
}

// ============================================================================
// Plugin Definition
// ============================================================================

const ragflowPlugin = {
  id: "ragflow-knowledge",
  name: "RAGFlow Knowledge Base",
  description: "RAGFlow-powered knowledge retrieval for OpenClaw",
  kind: "tool" as const,

  register(api: OpenClawPluginApi) {
    // Parse configuration with defaults
    const cfg: RAGFlowConfig = {
      apiUrl:
        (api.pluginConfig as Record<string, unknown>).apiUrl as string,
      apiKey: (api.pluginConfig as Record<string, unknown>).apiKey as string,
      datasetIds: (api.pluginConfig as Record<string, unknown>)
        .datasetIds as string[],
      autoInject: ((api.pluginConfig as Record<string, unknown>)
        .autoInject as boolean) ?? true,
      similarityThreshold: (api.pluginConfig as Record<string, unknown>)
        .similarityThreshold as number | undefined,
      topK: (api.pluginConfig as Record<string, unknown>).topK as number | undefined,
    };

    // Initialize RAGFlow client
    const client = new RAGFlowClient(cfg);

    api.logger.info(
      `ragflow-knowledge: initialized (API: ${cfg.apiUrl}, datasets: ${cfg.datasetIds?.length || 0})`,
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
                  `${index + 1}. [${chunk.document_keyword}] (相似度: ${(chunk.similarity * 100).toFixed(1)}%)\n${chunk.content}`,
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
                  `- **${d.name}** (ID: ${d.id})\n  ${d.description || "No description"}\n  Documents: ${d.chunk_num} chunks`,
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
            const chunks = await client.search({
              question: query,
              datasetIds: cfg.datasetIds,
              similarityThreshold: cfg.similarityThreshold,
              topK: Number.parseInt(opts.topK),
            });

            console.log(`\nFound ${chunks.length} result(s):\n`);
            chunks.forEach((chunk, index) => {
              console.log(
                `${index + 1}. [${chunk.document_keyword}] (${(chunk.similarity * 100).toFixed(1)}%)`,
              );
              console.log(`${chunk.content}\n`);
            });
          });

        ragflow
          .command("datasets")
          .description("List all knowledge bases")
          .action(async () => {
            const datasets = await client.listDatasets();
            console.log(`\nAvailable knowledge bases (${datasets.length}):\n`);
            datasets.forEach((d) => {
              console.log(`- ${d.name} (${d.id})`);
              console.log(`  ${d.description || "No description"}`);
              console.log(`  Chunks: ${d.chunk_num}\n`);
            });
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

          api.logger.info?.(
            `ragflow-knowledge: injecting ${chunks.length} chunks into context`,
          );

          // Format context for injection
          const context = chunks
            .map(
              (chunk) =>
                `[${chunk.document_keyword}] ${chunk.content}`,
            )
            .join("\n\n---\n\n");

          return {
            prependContext: `<ragflow-knowledge>\nRelevant information from knowledge base:\n${context}\n</ragflow-knowledge>`,
          };
        } catch (err) {
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
        // Test API connection at startup
        try {
          await client.testConnection();
          api.logger.info(
            `ragflow-knowledge: started (API: ${cfg.apiUrl}, auto-inject: ${cfg.autoInject})`,
          );
        } catch (error) {
          api.logger.error(
            `ragflow-knowledge: failed to connect to RAGFlow API: ${error}`,
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
