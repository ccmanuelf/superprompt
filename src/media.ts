import { writeFileSync, readdirSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { UPLOADS_DIR } from './config.js';
import { logger } from './logger.js';

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Sanitize a filename to only allow safe characters.
 * Replaces everything except [a-zA-Z0-9._-] with underscores.
 */
export function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Download media from a URL and save to workspace/uploads/.
 * Returns the local file path.
 */
export async function downloadMedia(
  url: string,
  originalFilename?: string,
): Promise<string> {
  mkdirSync(UPLOADS_DIR, { recursive: true });

  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} from ${url}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  // Build safe filename
  const ext = originalFilename
    ? extname(originalFilename)
    : guessExtension(res.headers.get('content-type'));
  const safeName = originalFilename
    ? sanitizeFilename(originalFilename)
    : `file${ext}`;
  const localPath = resolve(UPLOADS_DIR, `${Date.now()}_${safeName}`);

  writeFileSync(localPath, buffer);

  logger.debug(
    { path: localPath, size: buffer.length },
    'Media downloaded',
  );

  return localPath;
}

/**
 * Build a message string describing a received photo.
 * Used to pass context to the AI provider.
 */
export function buildPhotoMessage(
  filePath: string,
  caption?: string,
): string {
  const parts = ['[Photo received]'];
  parts.push(`File: ${filePath}`);
  if (caption) parts.push(`Caption: ${caption}`);
  parts.push('Please describe or analyze the photo based on the caption.');
  return parts.join('\n');
}

/**
 * Build a message string describing a received document.
 */
export function buildDocumentMessage(
  filePath: string,
  filename: string,
  caption?: string,
): string {
  const parts = [`[Document received: ${filename}]`];
  parts.push(`File: ${filePath}`);
  if (caption) parts.push(`Caption: ${caption}`);
  parts.push('Please analyze the document content.');
  return parts.join('\n');
}

/**
 * Build a message string describing a received video.
 */
export function buildVideoMessage(
  filePath: string,
  caption?: string,
): string {
  const parts = ['[Video received]'];
  parts.push(`File: ${filePath}`);
  if (caption) parts.push(`Caption: ${caption}`);
  parts.push('Please analyze the video content.');
  return parts.join('\n');
}

/**
 * Delete uploaded files older than maxAgeMs.
 * Call on startup and optionally on a schedule.
 */
export function cleanupOldUploads(maxAgeMs: number = DEFAULT_MAX_AGE_MS): number {
  mkdirSync(UPLOADS_DIR, { recursive: true });

  const now = Date.now();
  let deleted = 0;

  try {
    const files = readdirSync(UPLOADS_DIR);

    for (const file of files) {
      if (file === '.gitkeep') continue;

      const filePath = resolve(UPLOADS_DIR, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(filePath);
          deleted++;
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Directory might not exist yet
  }

  if (deleted > 0) {
    logger.info({ deleted }, 'Cleaned up old uploads');
  }

  return deleted;
}

function guessExtension(contentType: string | null): string {
  if (!contentType) return '';
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'video/mp4': '.mp4',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
  };
  return map[contentType.split(';')[0].trim()] || '';
}
