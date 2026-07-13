/**
 * [send-file:<path>] marker (spec 2026-07-13 §6) — Claude-path file
 * delivery. The claude -p subprocess can't push documents into the chat;
 * wrapper tools (e.g. `sam export`) write under the uploads dir and the
 * model embeds this marker. Validation is strict (absolute, resolves
 * INSIDE the uploads dir, traversal-proof); failure is soft (marker
 * stripped, text still delivered).
 */
import { describe, it, expect } from 'vitest';
import {
  extractSendFileMarkers,
  validateSendFilePath,
  sendFileDisplayName,
} from '../src/platforms/send-file-marker.js';

const UPLOADS = '/app/workspace/uploads';

describe('extractSendFileMarkers', () => {
  it('extracts a marker and strips it from the text', () => {
    const { cleaned, paths } = extractSendFileMarkers(
      'Here is the workbook. [send-file:/app/workspace/uploads/1760000000000_sam-analysis-3.xlsx] Let me know.',
    );
    expect(paths).toEqual(['/app/workspace/uploads/1760000000000_sam-analysis-3.xlsx']);
    expect(cleaned).not.toContain('[send-file:');
    expect(cleaned).toContain('Here is the workbook.');
    expect(cleaned).toContain('Let me know.');
  });

  it('handles multiple markers', () => {
    const { paths } = extractSendFileMarkers(
      '[send-file:/app/workspace/uploads/a.xlsx]\n[send-file:/app/workspace/uploads/b.xlsx]',
    );
    expect(paths).toEqual(['/app/workspace/uploads/a.xlsx', '/app/workspace/uploads/b.xlsx']);
  });

  it('returns text unchanged (modulo trim) when there is no marker', () => {
    const { cleaned, paths } = extractSendFileMarkers('No files here.');
    expect(paths).toEqual([]);
    expect(cleaned).toBe('No files here.');
  });
});

describe('validateSendFilePath', () => {
  it('accepts an absolute path inside the uploads dir', () => {
    expect(validateSendFilePath(`${UPLOADS}/1760000000000_sam-analysis-3.xlsx`, UPLOADS))
      .toBe(`${UPLOADS}/1760000000000_sam-analysis-3.xlsx`);
  });
  it('rejects traversal that escapes the uploads dir', () => {
    expect(validateSendFilePath(`${UPLOADS}/../../etc/passwd`, UPLOADS)).toBeNull();
    expect(validateSendFilePath(`${UPLOADS}/sub/../../secrets.txt`, UPLOADS)).toBeNull();
  });
  it('accepts traversal that stays inside the uploads dir after resolution', () => {
    expect(validateSendFilePath(`${UPLOADS}/sub/../a.xlsx`, UPLOADS)).toBe(`${UPLOADS}/a.xlsx`);
  });
  it('rejects relative paths', () => {
    expect(validateSendFilePath('uploads/a.xlsx', UPLOADS)).toBeNull();
    expect(validateSendFilePath('./a.xlsx', UPLOADS)).toBeNull();
  });
  it('rejects the uploads dir itself and sibling dirs with a shared prefix', () => {
    expect(validateSendFilePath(UPLOADS, UPLOADS)).toBeNull();
    expect(validateSendFilePath('/app/workspace/uploads-evil/a.xlsx', UPLOADS)).toBeNull();
  });
  it('rejects empty input', () => {
    expect(validateSendFilePath('', UPLOADS)).toBeNull();
    expect(validateSendFilePath('   ', UPLOADS)).toBeNull();
  });
});

describe('sendFileDisplayName', () => {
  it('strips the timestamp prefix wrappers prepend', () => {
    expect(sendFileDisplayName(`${UPLOADS}/1760000000000_sam-analysis-3.xlsx`)).toBe('sam-analysis-3.xlsx');
  });
  it('leaves ordinary filenames alone', () => {
    expect(sendFileDisplayName(`${UPLOADS}/report.xlsx`)).toBe('report.xlsx');
  });
});
