/**
 * luna-parsers — Process 3 entry point.
 *
 * File parsing only — the tightest sandbox:
 * - parse_file: PDF, XLSX, DOCX, CSV, PPTX, JSON, MD, TXT
 * - generate_document: XLSX, DOCX, PDF, CSV, PPTX generation
 *
 * Security boundary:
 * - NO database access
 * - NO network access (no API keys in env)
 * - NO bot tokens
 * - Only file paths (WORKSPACE_DIR, UPLOADS_DIR) in env
 *
 * Even if a malicious file exploits a parsing library (pdf-parse, mammoth, etc.),
 * the attacker is contained in a process with no credentials, no network, and no DB.
 *
 * Spawned by Process 1 via child_process.fork().
 */

import { registerLocalTool, startIPCServer } from './ipc/server.js';

import { parseFileDefinition, parseFileTool } from './providers/tools/parse-file.js';
import { generateDocumentDefinition, generateDocumentTool } from './providers/tools/generate-document.js';

// ── Register parser tools only ──────────────────────────────

registerLocalTool({
  definition: parseFileDefinition,
  execute: async (args) => parseFileTool(args as { path: string }),
  source: 'builtin',
  process: 'parsers',
});

registerLocalTool({
  definition: generateDocumentDefinition,
  execute: async (args) => generateDocumentTool(args),
  source: 'builtin',
  process: 'parsers',
});

// ── Start IPC server ────────────────────────────────────────

startIPCServer('parsers');
