/**
 * Upload manifest (rc.71) — surfaces the bot's recent uploads to the
 * model so it doesn't hallucinate file paths.
 *
 * Small models (e.g. qwen3.5:2b) can't invent a path they've been
 * handed. Injecting a short, explicit list of recent uploads into
 * the system prompt — with exact absolute paths the model must
 * quote verbatim — eliminates an entire class of path-guessing
 * failures observed in rc.69/70 diagnostics.
 *
 * This module intentionally does NOT talk to the DB. The filesystem
 * is the source of truth for uploads, and we want this path to
 * never fail in a way that could block a user message.
 */
import { readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { UPLOADS_DIR } from './config.js';
import { logger } from './logger.js';

export interface UploadEntry {
  path: string;            // absolute path
  filename: string;        // base name (with the bot's timestamp prefix)
  sizeBytes: number;
  modifiedAt: number;      // ms since epoch
  extension: string;       // lowercase, includes dot, or '' if none
}

/**
 * Return the N most recently modified files under UPLOADS_DIR.
 * Directory missing → empty list, no throw. Hidden files (e.g.
 * .gitkeep) are filtered out.
 */
export async function getRecentUploads(limit = 10): Promise<UploadEntry[]> {
  try {
    const entries = await readdir(UPLOADS_DIR);
    const candidates = entries.filter((name) => !name.startsWith('.'));

    const stats = await Promise.all(
      candidates.map(async (name) => {
        const path = join(UPLOADS_DIR, name);
        try {
          const s = await stat(path);
          if (!s.isFile()) return null;
          return {
            path,
            filename: name,
            sizeBytes: s.size,
            modifiedAt: s.mtimeMs,
            extension: extname(name).toLowerCase(),
          } as UploadEntry;
        } catch {
          return null;
        }
      }),
    );

    return (stats.filter(Boolean) as UploadEntry[])
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .slice(0, limit);
  } catch (err) {
    // UPLOADS_DIR might not exist yet on fresh install — not an error.
    logger.debug({ err }, 'getRecentUploads: UPLOADS_DIR not readable');
    return [];
  }
}

/**
 * Render the manifest as a short, model-readable block. Each entry
 * gives the absolute path the model MUST use verbatim, a size hint,
 * and an age hint — with explicit instructions NOT to invent paths.
 * Returns empty string when there are no uploads, so the router can
 * skip the prompt concatenation entirely.
 */
export function formatUploadManifest(entries: UploadEntry[]): string {
  if (entries.length === 0) return '';

  const now = Date.now();
  const lines = entries.map((e) => {
    const ageMin = Math.max(1, Math.round((now - e.modifiedAt) / 60_000));
    const ageLabel =
      ageMin < 60 ? `${ageMin}m ago` :
      ageMin < 1440 ? `${Math.round(ageMin / 60)}h ago` :
      `${Math.round(ageMin / 1440)}d ago`;
    const sizeKb = Math.max(1, Math.round(e.sizeBytes / 1024));
    return `- ${e.path} (${sizeKb} KB, ${ageLabel}${e.extension ? `, ${e.extension}` : ''})`;
  });

  return [
    '## Available uploads',
    'The following files are in the bot\'s uploads directory and can be read with read_file or parse_file. '
    + 'When the user references an uploaded file, use one of these EXACT absolute paths — do NOT invent or guess filenames.',
    '',
    ...lines,
  ].join('\n');
}

/**
 * Build a structured not-found error for a file tool whose given
 * path didn't exist. Surfaces the attempted path, a one-line hint,
 * and a list of actually-available upload paths so the model can
 * self-correct by picking from a real list instead of guessing again.
 *
 * Designed to be returned directly as the tool result — the small
 * model sees it and, with the attached `available` list, typically
 * retries with a valid path on the next iteration.
 */
export async function buildNotFoundHint(attemptedPath: string): Promise<{
  error: string;
  suggestion: string;
  available: string[];
}> {
  const uploads = await getRecentUploads(20);
  return {
    error: `File not found: "${attemptedPath}". This path does not exist on disk.`,
    suggestion:
      uploads.length > 0
        ? 'Do NOT retry with another guessed path. Pick one of the absolute paths in `available` below — those are the actual files in the bot\'s uploads directory.'
        : 'There are no files in the bot\'s uploads directory. Ask the user to upload the file first.',
    available: uploads.map((u) => u.path),
  };
}

