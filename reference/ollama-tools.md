# Ollama Tool Calling — Patterns & Reference

## Dual-Model Strategy

Luna uses two Ollama models with automatic switching:

- **Chat model** (`OLLAMA_CHAT_MODEL`): `qwen3:4b`
  - Used for general conversation, reasoning, analysis
  - Lightweight, fast responses for chat-only messages
  - Thinking mode enabled by default (`think: true`)

- **Tool model** (`OLLAMA_TOOL_MODEL`): `qwen3:latest` (8B)
  - Used when the message requires tool calls
  - Latest Qwen3 with optimized tool calling support
  - Thinking mode enabled

### Routing Heuristic

Detection logic for routing to tool model:
- Message contains action verbs: search, read, check, find, get, look up, fetch, query, save, remember
- Combined with nouns that map to tool descriptions: file, url, web, time, date, memory, system, command
- Explicit tool requests: "use tools", "search for", "read the file"
- Fallback: if unsure, use chat model (cheaper, better quality for non-tool tasks)

---

## Tool Definitions (8 Curated Tools)

### 1. web-search
```typescript
{
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for current information. Use for questions about recent events, facts, or topics you are unsure about.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' }
      },
      required: ['query']
    }
  }
}
```
Implementation: SearXNG instance (self-hosted) or Brave Search API. Returns top 5 results with title, URL, snippet.

### 2. read-file
```typescript
{
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read the contents of a file from the filesystem. Only works on allowed paths.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' }
      },
      required: ['path']
    }
  }
}
```
Implementation: Reads file with path validation. Allowed paths configured via `OLLAMA_ALLOWED_PATHS` env var. Returns first 10,000 chars with truncation notice.

### 3. run-command
```typescript
{
  type: 'function',
  function: {
    name: 'run_command',
    description: 'Execute a shell command. Only whitelisted commands are allowed (ls, cat, head, tail, wc, date, uptime, df, free, ps, echo, pwd, which, file, stat).',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' }
      },
      required: ['command']
    }
  }
}
```
Implementation: Parses command, validates first token against whitelist, runs with 10s timeout, captures stdout+stderr. Max 5000 chars output.

### 4. query-memory
```typescript
{
  type: 'function',
  function: {
    name: 'query_memory',
    description: 'Search stored memories for relevant information. Use when the user asks about something you might have discussed before or when you need context about past conversations.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for memories' },
        limit: { type: 'number', description: 'Max results to return (default 5)' }
      },
      required: ['query']
    }
  }
}
```
Implementation: Calls `buildMemoryContext()` from `memory.ts`. Returns formatted memory entries.

### 5. save-memory
```typescript
{
  type: 'function',
  function: {
    name: 'save_memory',
    description: 'Save an important fact or piece of information to long-term memory. Use when the user tells you something important about themselves, their preferences, or facts they want you to remember.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The information to remember' },
        sector: { type: 'string', enum: ['semantic', 'episodic'], description: 'Type: semantic for facts/preferences, episodic for events/conversations' }
      },
      required: ['content']
    }
  }
}
```
Implementation: Inserts directly into memories table via db.ts functions.

### 6. get-time
```typescript
{
  type: 'function',
  function: {
    name: 'get_time',
    description: 'Get the current date, time, and timezone.',
    parameters: {
      type: 'object',
      properties: {}
    }
  }
}
```
Implementation: Returns `{ date, time, timezone, unix }` from system clock.

### 7. system-info
```typescript
{
  type: 'function',
  function: {
    name: 'system_info',
    description: 'Get basic system information including uptime, memory usage, disk space, and OS details.',
    parameters: {
      type: 'object',
      properties: {}
    }
  }
}
```
Implementation: Uses Node.js `os` module for uptime, memory, platform, hostname. Runs `df -h /` for disk.

### 8. summarize-url
```typescript
{
  type: 'function',
  function: {
    name: 'summarize_url',
    description: 'Fetch a URL and return a summary of its content. Useful for getting information from web pages.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch and summarize' }
      },
      required: ['url']
    }
  }
}
```
Implementation: Fetches URL with 10s timeout, strips HTML tags, truncates to 5000 chars, returns text content. Model does the actual summarization from context.

---

## Agentic Loop Pattern

```typescript
async function runAgenticLoop(
  messages: ChatMessage[],
  tools: Tool[],
  maxIterations: number = 10
): Promise<string> {
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    const response = await ollama.chat({
      model: OLLAMA_TOOL_MODEL,
      messages,
      tools,
      think: true,
      options: { num_ctx: 32768 }
    });

    // Add assistant response to history
    messages.push(response.message);

    // If no tool calls, we're done
    if (!response.message.tool_calls?.length) {
      return response.message.content;
    }

    // Execute each tool call
    for (const toolCall of response.message.tool_calls) {
      const result = await executeTool(
        toolCall.function.name,
        toolCall.function.arguments
      );

      messages.push({
        role: 'tool',
        content: JSON.stringify(result)
      });
    }
  }

  // Max iterations reached — return last content or warning
  return messages.at(-1)?.content || '[Max tool iterations reached]';
}
```

### Key Implementation Notes

1. **MAX_ITERATIONS = 10**: Hard guard against infinite loops. Models can call tools repeatedly.
2. **No `tool_choice`**: Ollama doesn't support forcing tool usage. System prompt must encourage it.
3. **Thinking tokens**: With `think: true`, the model produces thinking tokens that don't appear in output but use memory. Monitor for long conversations.
4. **Tool result format**: Always JSON-stringify tool results. The model expects structured data.
5. **Error handling**: If a tool fails, return `{ error: "description" }` — don't throw. Let the model handle the error gracefully.
6. **Context window**: `num_ctx: 32768` for tool model. The fine-tuned chat model supports 40k but default Ollama is 2048 if not set.

### System Prompt for Tool Model

```
You are luna, a helpful AI assistant. You have access to tools that let you interact with the system.

When the user asks you to do something that requires tools, use them. Don't say you can't do something if there's a tool that can help.

Available tools: web_search, read_file, run_command, query_memory, save_memory, get_time, system_info, summarize_url.

When you learn something important about the user, use save_memory to remember it.
When you need information from past conversations, use query_memory.

Always provide a final text response after using tools — don't end with just a tool call.
```

---

## Conversation History Management

- Per-chat history stored in-memory (Map<chatId, ChatMessage[]>)
- Retain last 20 turns (40 messages — user + assistant pairs)
- Trim from front when exceeding limit
- System message is always first and not counted in turn limit
- Tool call/result messages count as part of the turn they belong to
- On `/newchat` command, clear the history for that chat
