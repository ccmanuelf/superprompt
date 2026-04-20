import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Integration-ish tests for transcribeAudio / synthesizeSpeech against a
 * mocked OpenAI-compatible Speaches client. Purpose:
 *
 *  1. Lock in the behavior that short/undecodable STT payloads never throw a
 *     415 up to the caller — they map to an empty transcript (equivalent to
 *     "no speech"). This was the regression that made the web Chat UI
 *     unusable: the browser sent tiny webms, Speaches returned 415, and the
 *     whole pipeline threw.
 *  2. Lock in the TTS cold-start retry — the first Kokoro call after an idle
 *     unload times out, and a single warm retry should recover without the
 *     caller noticing.
 */

// Capture the constructor args & shape the SDK surface ---------------------

const mockCreateTranscription = vi.fn();
const mockCreateSpeech = vi.fn();

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      audio = {
        transcriptions: { create: mockCreateTranscription },
        speech: { create: mockCreateSpeech },
      };
      constructor(_opts: unknown) {}
    },
  };
});

// Import under test AFTER the mock is registered
const { transcribeAudio, synthesizeSpeech, ttsPlainText } = await import('../src/voice.js');

// Helpers -------------------------------------------------------------------

const TMP = mkdtempSync(join(tmpdir(), 'clauded-voice-test-'));

function writeAudio(name: string, bytes: number): string {
  const path = join(TMP, name);
  writeFileSync(path, Buffer.alloc(bytes, 0xaa));
  return path;
}

/** Build an error that mimics what the OpenAI SDK throws on HTTP status errors. */
function apiError(status: number, message = 'decode failed'): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function socketTimeout(): Error {
  const err = new Error('Invalid response body: Socket timeout') as Error & { code: string };
  err.code = 'ERR_SOCKET_TIMEOUT';
  return err;
}

beforeEach(() => {
  mockCreateTranscription.mockReset();
  mockCreateSpeech.mockReset();
});

// STT tests -----------------------------------------------------------------

describe('transcribeAudio: undecodable / tiny inputs', () => {
  it('short-circuits on sub-2KB files without hitting Speaches', async () => {
    const path = writeAudio('tiny.webm', 300);

    const result = await transcribeAudio(path);

    expect(result).toEqual({ text: '', detectedLanguage: null });
    expect(mockCreateTranscription).not.toHaveBeenCalled();
  });

  it('maps Speaches 415 to an empty transcript instead of throwing', async () => {
    const path = writeAudio('corrupt.webm', 5_000);
    mockCreateTranscription.mockRejectedValueOnce(
      apiError(415, 'Failed to decode audio. The provided file type is not supported.'),
    );

    const result = await transcribeAudio(path);

    expect(result).toEqual({ text: '', detectedLanguage: null });
    expect(mockCreateTranscription).toHaveBeenCalledTimes(1);
  });

  it('propagates non-415 errors so callers can surface real failures', async () => {
    const path = writeAudio('normal.webm', 5_000);
    mockCreateTranscription.mockRejectedValueOnce(apiError(500, 'whisper crashed'));

    await expect(transcribeAudio(path)).rejects.toThrow('whisper crashed');
  });

  it('returns the transcribed text on a normal Speaches response', async () => {
    const path = writeAudio('hello.webm', 10_000);
    const spanishSample =
      'Hola, ¿cómo estás? Hoy quiero revisar el pronóstico de producción ' +
      'y asegurarme de que el inventario para la próxima semana sea suficiente.';
    mockCreateTranscription.mockResolvedValueOnce({ text: spanishSample });

    const result = await transcribeAudio(path);

    expect(result.text).toBe(spanishSample);
    // franc needs ~50+ chars of meaningful text to confidently identify a language
    expect(result.detectedLanguage).toBe('es');
  });
});

// TTS tests -----------------------------------------------------------------

describe('synthesizeSpeech: cold-start retry', () => {
  function fakeAudio(): { arrayBuffer: () => Promise<ArrayBuffer> } {
    return { arrayBuffer: async () => new Uint8Array([0xff, 0xfb, 0x90]).buffer };
  }

  it('retries once on socket timeout and succeeds on warm second attempt', async () => {
    mockCreateSpeech
      .mockRejectedValueOnce(socketTimeout())
      .mockResolvedValueOnce(fakeAudio());

    const buf = await synthesizeSpeech('hello', 'en');

    expect(buf).toBeInstanceOf(Buffer);
    expect(mockCreateSpeech).toHaveBeenCalledTimes(2);
  });

  it('does not retry on genuine API errors like 400', async () => {
    const err = apiError(400, 'bad voice');
    mockCreateSpeech.mockRejectedValueOnce(err);

    await expect(synthesizeSpeech('hello', 'en')).rejects.toThrow('bad voice');
    expect(mockCreateSpeech).toHaveBeenCalledTimes(1);
  });

  it('surfaces the error if both attempts time out', async () => {
    mockCreateSpeech
      .mockRejectedValueOnce(socketTimeout())
      .mockRejectedValueOnce(socketTimeout());

    await expect(synthesizeSpeech('hello', 'en')).rejects.toThrow(/Socket timeout/);
    expect(mockCreateSpeech).toHaveBeenCalledTimes(2);
  });

  it('returns an empty buffer (no HTTP call) when input has nothing speakable', async () => {
    const buf = await synthesizeSpeech('   \n\n   ', 'en');
    expect(buf.length).toBe(0);
    expect(mockCreateSpeech).not.toHaveBeenCalled();
  });

  it('passes the markdown-stripped text to Speaches, not the raw markdown', async () => {
    mockCreateSpeech.mockResolvedValueOnce({ arrayBuffer: async () => new Uint8Array([1, 2]).buffer });

    await synthesizeSpeech('**Hola** _mundo_\n- item 1\n- item 2', 'es');

    expect(mockCreateSpeech).toHaveBeenCalledTimes(1);
    const call = mockCreateSpeech.mock.calls[0][0];
    expect(call.input).not.toContain('**');
    expect(call.input).not.toContain('_');
    expect(call.input).not.toMatch(/^- /m);
    expect(call.input).toContain('Hola mundo');
  });
});

describe('ttsPlainText: markdown sanitization', () => {
  it('strips bold and italic markers', () => {
    expect(ttsPlainText('**Hola** y *adiós*')).toBe('Hola y adiós');
    expect(ttsPlainText('__strong__ and _em_')).toBe('strong and em');
  });

  it('flattens bullet and numbered lists', () => {
    expect(ttsPlainText('- one\n- two\n- three')).toBe('one two three');
    expect(ttsPlainText('1. first\n2. second')).toBe('first second');
  });

  it('removes heading markers but keeps the heading text', () => {
    expect(ttsPlainText('# Title\nBody here.')).toBe('Title Body here.');
    expect(ttsPlainText('### Section\ncontent')).toBe('Section content');
  });

  it('replaces fenced code blocks with a spoken placeholder', () => {
    const out = ttsPlainText('Try this:\n```\nconst x = 1;\n```\nOK?');
    expect(out).not.toContain('```');
    expect(out).toMatch(/code block/);
  });

  it('unwraps markdown links to their visible label', () => {
    expect(ttsPlainText('see [the docs](https://example.com) please'))
      .toBe('see the docs please');
  });

  it('collapses whitespace so the TTS speaks naturally', () => {
    expect(ttsPlainText('line one\n\n\nline two\t\there')).toBe('line one line two here');
  });

  it('returns empty string when input has nothing speakable', () => {
    expect(ttsPlainText('')).toBe('');
    expect(ttsPlainText('```\njust code\n```')).toBe('code block.');
    expect(ttsPlainText('   \n\n   ')).toBe('');
  });
});
