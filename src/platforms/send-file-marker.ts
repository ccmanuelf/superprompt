/**
 * `[send-file:<path>]` reply marker — Claude-path file delivery
 * (spec 2026-07-13 §6). The claude -p subprocess cannot push documents into
 * the chat itself; wrapper tools (e.g. `sam export`) write a file under the
 * uploads dir and print its path, and the model embeds this marker. The
 * platform extracts the marker(s), validates each path, sends the
 * document(s), and strips the marker from the visible text.
 *
 * Validation is strict — absolute path that RESOLVES inside the uploads dir
 * (traversal-checked on the resolved path, prefix-checked with a trailing
 * separator so `/uploads-evil` can't shadow `/uploads`). Failure is soft:
 * the caller strips the marker, logs a warning, and still delivers the
 * text (graceful degradation, Code Convention #6).
 */
import { basename, isAbsolute, resolve, sep } from 'node:path';

const MARKER_REGEX = /\[send-file:([^\]\n]+)\]/g;

/** Pull every marker out of the text; returns the cleaned text + raw paths. */
export function extractSendFileMarkers(text: string): { cleaned: string; paths: string[] } {
  const paths: string[] = [];
  const cleaned = text
    .replace(MARKER_REGEX, (_match, p: string) => {
      paths.push(p.trim());
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  return { cleaned, paths };
}

/**
 * Validate a marker path: absolute, and its RESOLVED form must live inside
 * uploadsDir (not the dir itself). Returns the resolved path, or null.
 */
export function validateSendFilePath(rawPath: string, uploadsDir: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || !isAbsolute(trimmed)) return null;
  const resolved = resolve(trimmed);
  const root = resolve(uploadsDir);
  if (!resolved.startsWith(root + sep)) return null;
  return resolved;
}

/** Display filename: strip the `<epoch-ms>_` prefix upload writers prepend. */
export function sendFileDisplayName(path: string): string {
  return basename(path).replace(/^\d{10,}_/, '');
}
