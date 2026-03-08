import { describe, it, expect } from 'vitest';
import { formatForTelegram, splitMessage } from '../src/platforms/telegram.js';

// ── formatForTelegram ────────────────────────────────────────

describe('formatForTelegram', () => {
  it('converts **bold** to <b>', () => {
    expect(formatForTelegram('**hello**')).toBe('<b>hello</b>');
  });

  it('converts __bold__ to <b>', () => {
    expect(formatForTelegram('__hello__')).toBe('<b>hello</b>');
  });

  it('converts *italic* to <i>', () => {
    expect(formatForTelegram('*hello*')).toBe('<i>hello</i>');
  });

  it('converts _italic_ to <i>', () => {
    expect(formatForTelegram('_hello_')).toBe('<i>hello</i>');
  });

  it('converts ~~strikethrough~~ to <s>', () => {
    expect(formatForTelegram('~~deleted~~')).toBe('<s>deleted</s>');
  });

  it('converts markdown links to <a>', () => {
    expect(formatForTelegram('[Click](https://example.com)')).toBe(
      '<a href="https://example.com">Click</a>',
    );
  });

  it('converts # headings to bold', () => {
    expect(formatForTelegram('# Title')).toBe('<b>Title</b>');
    expect(formatForTelegram('## Subtitle')).toBe('<b>Subtitle</b>');
    expect(formatForTelegram('### Deep')).toBe('<b>Deep</b>');
  });

  it('converts checkboxes', () => {
    expect(formatForTelegram('- [ ] todo')).toContain('☐');
    expect(formatForTelegram('- [x] done')).toContain('☑');
    expect(formatForTelegram('- [X] done')).toContain('☑');
  });

  it('strips horizontal rules', () => {
    expect(formatForTelegram('---').trim()).toBe('');
    expect(formatForTelegram('***').trim()).toBe('');
  });

  it('escapes HTML in regular text', () => {
    expect(formatForTelegram('x < y & z > w')).toBe('x &lt; y &amp; z &gt; w');
  });

  it('protects inline code from formatting', () => {
    const result = formatForTelegram('Use `**not bold**` here');
    expect(result).toContain('<code>**not bold**</code>');
    expect(result).not.toContain('<b>');
  });

  it('protects code blocks from formatting', () => {
    const input = '```js\nconst x = 1;\n```';
    const result = formatForTelegram(input);
    expect(result).toContain('<pre><code');
    expect(result).toContain('const x = 1;');
    // Should NOT have bold/italic conversions inside code
    expect(result).not.toContain('**');
  });

  it('escapes HTML inside code blocks', () => {
    const input = '```\n<script>alert(1)</script>\n```';
    const result = formatForTelegram(input);
    expect(result).toContain('&lt;script&gt;');
  });

  it('converts ***bold-italic*** to properly nested <b><i>', () => {
    expect(formatForTelegram('***hello***')).toBe('<b><i>hello</i></b>');
  });

  it('converts ___bold-italic___ to properly nested <b><i>', () => {
    expect(formatForTelegram('___hello___')).toBe('<b><i>hello</i></b>');
  });

  it('handles bold-italic in a sentence', () => {
    const result = formatForTelegram('the book ***Relentless*** by Lewis');
    expect(result).toBe('the book <b><i>Relentless</i></b> by Lewis');
  });

  it('handles mixed formatting', () => {
    const input = '**bold** and *italic* and `code`';
    const result = formatForTelegram(input);
    expect(result).toContain('<b>bold</b>');
    expect(result).toContain('<i>italic</i>');
    expect(result).toContain('<code>code</code>');
  });

  it('handles empty string', () => {
    expect(formatForTelegram('')).toBe('');
  });

  it('handles plain text without formatting', () => {
    expect(formatForTelegram('just plain text')).toBe('just plain text');
  });
});

// ── splitMessage ─────────────────────────────────────────────

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    const chunks = splitMessage('hello', 100);
    expect(chunks).toEqual(['hello']);
  });

  it('splits on newlines', () => {
    const text = 'line1\nline2\nline3';
    const chunks = splitMessage(text, 10);
    expect(chunks.length).toBeGreaterThan(1);
    // All text should be preserved
    expect(chunks.join('\n')).toContain('line1');
    expect(chunks.join('\n')).toContain('line3');
  });

  it('splits on spaces when no newlines available', () => {
    const text = 'word1 word2 word3 word4 word5';
    const chunks = splitMessage(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('hard splits at limit when no spaces or newlines', () => {
    const text = 'a'.repeat(30);
    const chunks = splitMessage(text, 10);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(10);
    expect(chunks.join('')).toBe(text);
  });

  it('uses default limit of 4096', () => {
    const shortText = 'a'.repeat(4000);
    expect(splitMessage(shortText)).toEqual([shortText]);

    const longText = 'a'.repeat(5000);
    expect(splitMessage(longText).length).toBeGreaterThan(1);
  });

  it('handles empty string', () => {
    expect(splitMessage('')).toEqual(['']);
  });
});
