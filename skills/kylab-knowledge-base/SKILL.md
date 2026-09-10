---
name: kylab-knowledge-base
description: Query a kylab knowledge base to answer questions from the user's own documents with traceable citations. Use this Skill whenever the user asks something that their local knowledge base might cover — product manuals, research papers, internal guidelines, subscribed feeds — or explicitly says "查知识库", "在我的文档里找", "知识库里有没有", "ask my knowledge base", "search my docs". Also use it before answering from general knowledge when the answer should be grounded in the user's own material, because kylab returns the actual source passages rather than a generated summary.
---

# Query a kylab knowledge base

kylab is a local, self-hosted knowledge base. Its core capability is **retrieval with
traceable sources**: `search` returns the actual passages from the user's documents
(together with document name, page, and heading path), not a generated answer. That
distinction matters — when the user needs to trust or verify an answer, the passages are
the evidence, and a summary is not.

## Standard workflow

1. Call `list_knowledge_bases` to see which libraries exist.
   **Do this first**: retrieval is scoped per library, and a library that doesn't contain
   the material will return nothing no matter how good the query is.
2. Call `search` with a natural-language query and the relevant `knowledge_base_ids`.
   Leave `knowledge_base_ids` empty only when the user genuinely wants to search
   everything.
3. Read the returned passages and answer **from them**, citing the document name
   (and page/heading when present) for each claim.
4. If a result set is empty or clearly off-topic, reformulate and search again before
   concluding the material is absent. Retrieval is keyword- and vector-sensitive:
   "眼轴监测" and "监测眼轴长度" can rank differently.

## Tools

| Tool | Use it when | Do not |
| --- | --- | --- |
| `list_knowledge_bases` | Always, at the start; and again after the user adds documents | Assume a library id — they are generated and opaque |
| `search` | The default action for answering anything | Use it as a substitute for reading the returned text; the passages are the answer's basis |
| `upload_document` | The user hands you a file (base64) to add | Re-upload the same content to "refresh" it — content-hash dedup returns the existing document instead |
| `add_data_source` | The user wants a feed or page kept up to date | Expect content to appear immediately — registering does **not** fetch |
| `get_document_status` | After an upload, or when search finds nothing | Assume a non-`indexed` document is searchable; it is not |
| `delete_document` | The user explicitly asks to remove something | Treat it as reversible without saying so — the original goes to a 7-day trash, but the chunks and vectors are gone immediately, so it stops being searchable at once |
| `create_knowledge_base` | The user wants a new, separate library | Mix unrelated material into one library; separate libraries keep retrieval scoped |

## Answering rules

**Ground every claim in a returned passage.** If the passages don't support an answer, say
so plainly — "the knowledge base doesn't cover this" is a useful answer. Do not fill the
gap from general knowledge without labelling it as such: the user asked their own
documents precisely because general knowledge was not the point.

**Quote or point to the source.** Give the document name; add page and heading path when
kylab returns them. A claim the user cannot trace back is not usable for their purposes.

**Stages matter.** `get_document_status` reports a pipeline stage
(`uploaded → parsing → parsed → chunked → embedding → indexed`). Only `indexed` is
searchable. When a search comes up empty, check whether the document is merely still
processing before reporting the material as missing.

## Local setup

This Skill drives the kylab MCP server, which runs beside the kylab backend.

```bash
# from the kylab repository
cd backend
python -m app.mcp_server.server --list-tools          # confirm the 7 tools are visible
python -m app.mcp_server.server --transport stdio      # what an MCP client launches
```

MCP client configuration (Claude Desktop / Cursor and similar):

```json
{
  "mcpServers": {
    "kylab": {
      "command": "python",
      "args": ["-m", "app.mcp_server.server", "--transport", "stdio"],
      "cwd": "/absolute/path/to/kylab/backend",
      "env": { "KYLAB_DATA_DIR": "./data" }
    }
  }
}
```

For a machine on the LAN, start the HTTP transport instead — but read the warning below
first:

```bash
python -m app.mcp_server.server --transport http --host 0.0.0.0 --port 8765
```

**The HTTP transport has no authentication of its own and the tools can read *and delete*
documents.** Only bind it to `0.0.0.0` on a network you trust; the default is
`127.0.0.1` on purpose.

## Proxying a plain REST client

If the agent runtime cannot speak MCP, `scripts/kylab_query.py` in this Skill calls
kylab's REST API directly and prints the passages. Same retrieval, no MCP client needed:

```bash
python scripts/kylab_query.py --base-url http://127.0.0.1:8000 --query "眼轴怎么监测"
```
