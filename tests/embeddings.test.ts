import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the ollama module before importing embeddings
vi.mock('ollama', () => {
  const mockEmbed = vi.fn();
  return {
    Ollama: vi.fn().mockImplementation(() => ({
      embed: mockEmbed,
    })),
    __mockEmbed: mockEmbed,
  };
});

// Mock config
vi.mock('../src/config.js', () => ({
  config: {
    OLLAMA_HOST: 'http://localhost:11434',
  },
}));

// Mock logger
vi.mock('../src/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe('embeddings', () => {
  let generateEmbedding: typeof import('../src/embeddings.js').generateEmbedding;
  let generateEmbeddings: typeof import('../src/embeddings.js').generateEmbeddings;
  let mockEmbed: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Get mock reference
    const ollamaMod = await import('ollama');
    mockEmbed = (ollamaMod as unknown as { __mockEmbed: ReturnType<typeof vi.fn> }).__mockEmbed;

    // Re-import to get fresh module
    const mod = await import('../src/embeddings.js');
    generateEmbedding = mod.generateEmbedding;
    generateEmbeddings = mod.generateEmbeddings;
  });

  it('returns embedding vector on success', async () => {
    const fakeEmbedding = Array.from({ length: 768 }, (_, i) => i * 0.001);
    mockEmbed.mockResolvedValueOnce({ embeddings: [fakeEmbedding] });

    const result = await generateEmbedding('Hello world');
    expect(result).toEqual(fakeEmbedding);
    expect(result!.length).toBe(768);
  });

  it('returns null when Ollama is down', async () => {
    mockEmbed.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await generateEmbedding('Hello world');
    expect(result).toBeNull();
  });

  it('batch generates embeddings', async () => {
    const emb1 = Array.from({ length: 768 }, () => Math.random());
    const emb2 = Array.from({ length: 768 }, () => Math.random());
    mockEmbed.mockResolvedValueOnce({ embeddings: [emb1, emb2] });

    const result = await generateEmbeddings(['text1', 'text2']);
    expect(result.length).toBe(2);
    expect(result[0]).toEqual(emb1);
    expect(result[1]).toEqual(emb2);
  });

  it('batch returns nulls on failure', async () => {
    mockEmbed.mockRejectedValueOnce(new Error('timeout'));

    const result = await generateEmbeddings(['a', 'b', 'c']);
    expect(result).toEqual([null, null, null]);
  });

  it('returns empty array for empty input', async () => {
    const result = await generateEmbeddings([]);
    expect(result).toEqual([]);
    expect(mockEmbed).not.toHaveBeenCalled();
  });
});
