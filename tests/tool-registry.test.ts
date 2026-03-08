import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerTool,
  unregisterTool,
  executeRegisteredTool,
  getToolDefinitions,
  listRegisteredTools,
  type ToolEntry,
} from '../src/forge/tool-registry.js';

// Helper to create a simple test tool entry
function createTestEntry(name: string, description: string = 'Test tool'): ToolEntry {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description,
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Test input' },
          },
          required: ['input'],
        },
      },
    },
    execute: async (args) => ({ result: `processed: ${args.input}` }),
    source: 'builtin',
  };
}

describe('tool-registry', () => {
  beforeEach(() => {
    // Clean up any test tools
    for (const tool of listRegisteredTools()) {
      if (tool.name.startsWith('test_')) {
        unregisterTool(tool.name);
      }
    }
  });

  it('registers and executes a tool', async () => {
    const entry = createTestEntry('test_echo');
    registerTool(entry);

    const result = await executeRegisteredTool('test_echo', { input: 'hello' }, 'chat1');
    expect(result).toEqual({ result: 'processed: hello' });

    unregisterTool('test_echo');
  });

  it('returns error for unknown tool', async () => {
    const result = await executeRegisteredTool('nonexistent_tool', {}, 'chat1');
    expect(result.error).toContain('Unknown tool');
  });

  it('lists registered tools', () => {
    registerTool(createTestEntry('test_list1', 'First tool'));
    registerTool(createTestEntry('test_list2', 'Second tool'));

    const tools = listRegisteredTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('test_list1');
    expect(names).toContain('test_list2');

    unregisterTool('test_list1');
    unregisterTool('test_list2');
  });

  it('filters tool definitions by allowed list', () => {
    registerTool(createTestEntry('test_allowed'));
    registerTool(createTestEntry('test_not_allowed'));

    const filtered = getToolDefinitions(['test_allowed']);
    const names = filtered.map((t) => t.function.name);
    expect(names).toContain('test_allowed');
    expect(names).not.toContain('test_not_allowed');

    unregisterTool('test_allowed');
    unregisterTool('test_not_allowed');
  });

  it('unregisters a tool', () => {
    registerTool(createTestEntry('test_unreg'));
    expect(listRegisteredTools().some((t) => t.name === 'test_unreg')).toBe(true);

    unregisterTool('test_unreg');
    expect(listRegisteredTools().some((t) => t.name === 'test_unreg')).toBe(false);
  });

  it('handles tool execution errors gracefully', async () => {
    const errorEntry: ToolEntry = {
      ...createTestEntry('test_error'),
      execute: async () => { throw new Error('Test error'); },
    };
    registerTool(errorEntry);

    const result = await executeRegisteredTool('test_error', {}, 'chat1');
    expect(result.error).toContain('Test error');

    unregisterTool('test_error');
  });
});
