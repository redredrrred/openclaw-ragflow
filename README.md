# RAGFlow Knowledge Base Plugin for OpenClaw

Connect OpenClaw to [RAGFlow](https://ragflow.io) knowledge bases for intelligent document retrieval and Q&A.

## Features

- 🔍 **Search Knowledge Bases** - Query your RAGFlow knowledge bases directly from OpenClaw
- 🤖 **Auto-Context Injection** - Automatically injects relevant knowledge into AI conversations
- 📚 **Multiple Knowledge Bases** - Support for searching across multiple datasets
- 🎯 **Smart Retrieval** - Hybrid search with vector similarity + keyword matching
- 🛠️ **CLI Tools** - Command-line interface for quick searches
- 📊 **Source Citations** - See which documents the information came from

## Installation

### 1. Get RAGFlow API Credentials

1. Go to your RAGFlow console
2. Navigate to **Profile → API**
3. Copy your API Key
4. Note your RAGFlow server URL (e.g., `http://localhost:80`)

### 2. Configure the Plugin

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["ragflow-knowledge"],
    "entries": {
      "ragflow-knowledge": {
        "enabled": true,
        "config": {
          "apiUrl": "http://localhost:80",
          "apiKey": "${RAGFLOW_API_KEY}",
          "datasetIds": ["dataset-123"],
          "autoInject": true,
          "similarityThreshold": 0.2,
          "topK": 5,
          "maxInjectChars": 2000
        }
      }
    }
  }
}
```

**Configuration Options:**

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `apiUrl` | string | ✅ Yes | - | RAGFlow server URL |
| `apiKey` | string | ✅ Yes | - | RAGFlow API key |
| `datasetIds` | array | No | `null` (search all) | Specific dataset IDs to search |
| `autoInject` | boolean | No | `true` | Auto-inject relevant knowledge into conversations |
| `similarityThreshold` | number | No | API default | Minimum similarity score (0-1) |
| `topK` | number | No | API default | Maximum chunks to retrieve |
| `maxInjectChars` | number | No | `2000` | Maximum characters for auto-injected context |

### 3. Restart OpenClaw

```bash
openclaw restart
```

## Usage

### AI Agent Tools

The plugin registers tools that the AI can use:

- `ragflow_search` - Search knowledge base
- `ragflow_list_datasets` - List available knowledge bases

### CLI Commands

```bash
# Search knowledge base
openclaw ragflow search "your query"

# List all knowledge bases
openclaw ragflow datasets

# Check plugin health
openclaw ragflow health
```

### Auto-Context Injection

When enabled (default), the plugin automatically searches for relevant knowledge before each AI conversation and injects it into context. The AI will automatically have access to relevant information without needing explicit tool calls.

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiUrl` | string | Required | RAGFlow server URL |
| `apiKey` | string | Required | RAGFlow API key |
| `datasetIds` | array | All datasets | Specific datasets to search |
| `autoInject` | boolean | `true` | Auto-inject relevant context |
| `similarityThreshold` | number | RAGFlow API default | Minimum similarity (0-1) |
| `topK` | number | RAGFlow API default | Max chunks to retrieve |

## Troubleshooting

### Plugin Not Loading

```bash
# Check plugin status
openclaw doctor

# Check logs
tail -f ~/.openclaw/logs/gateway.log
```

### API Connection Error

```bash
# Check RAGFlow server is running
curl http://localhost:80/api/v1/datasets -H "Authorization: Bearer YOUR_API_KEY"

# Test plugin health
openclaw ragflow health
```

### Auto-Inject Not Working

- Check `autoInject: true` is set in config
- Verify `datasetIds` are correct (empty array = search all)
- Check plugin health status: `openclaw ragflow health`
- Plugin enters cooldown after 3 consecutive errors (1 minute cooldown)

### No Results Returned

- Lower `similarityThreshold` (e.g., `0.1` or `0.05`)
- Increase `topK` (e.g., `10`)
- Check dataset has documents uploaded
- Verify documents have been parsed
- Try manual search: `openclaw ragflow search "your query"`

## License

MIT

## Links

- [RAGFlow Documentation](https://ragflow.io/docs)
- [RAGFlow API Reference](https://ragflow.io/docs/dev/http_api_reference)
- [OpenClaw Plugins](https://docs.openclaw.ai/tools/plugin)

