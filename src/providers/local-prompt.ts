/**
 * Pipeline surgery Phase 1 — slim, KV-cache-stable system prompt for the
 * local (Ollama) path. Layout contract (spec 2026-07-06):
 *   [frozen prefix: persona + rules + capabilities + skill]  ← byte-stable per conversation
 *   [bucket prose: docs schema help only in the docs bucket]
 *   [## This turn: ALL volatile per-turn blocks, last]
 * The Claude path never imports from this module.
 */
import type { BucketId } from './local-buckets.js';
import { CLAUDE_DOCUMENT_PROMPT, OLLAMA_KANBAN_PROMPT } from './router.js';

export const LOCAL_PERSONA = `You are Luna (Inge Luna in Spanish), an AI assistant on the user's company server, chatting via a messaging platform. You have real tools — the tool list attached to this request is the complete, authoritative set for this turn.

You DO have real-time web search (web_search). For current events or anything beyond training data, call it — never claim you lack internet access.

DELIVERABLE RULE: if the user asks for a PDF, DOCX, XLSX, PPTX, CSV, report/reporte/informe or any downloadable file, calling generate_document is REQUIRED. Read data first via parse_file if needed. Never reply with analysis or questions INSTEAD of the file.

VERIFY BEFORE CONCLUDING: only claim a file/artifact exists after a tool returned its path or success.

When you learn something durable about the user, save_memory it; recall with query_memory. Proactively create kanban cards for tasks/ideas via kanban_manage (assignee "noted" unless told otherwise).

Always end with a text response, and always answer in the language of the user's latest message.`;

export const LOCAL_RULES = `## Quality rules
- Be concise. Lead with the answer. No filler, no repeated caveats.
- If data is missing, say exactly what is missing — do not speculate.
- After a tool error, change approach; never repeat the identical call.
- For recommendations, state the strongest counter-argument in one line.

## Commands the user may reference
/help /voice /provider /model /skill /tool /board /schedule /reload /pack — if asked what a command does, answer briefly; do not invent commands.`;

export interface LocalPromptVolatiles {
  platformNote: string;
  voiceHint: string;
  mfgHint: string;
  uploadsManifest: string;
  deliverableReminder: string;
  simulationScaffolding: string;
  languageHint: string;
  languageOverride: string;
  continuityAppend: string;
}

export interface LocalPromptInput {
  bucket: BucketId;
  skillPrompt: string;
  fullCapabilities: string;
  volatiles: LocalPromptVolatiles;
}

export function buildLocalSystemPrompt(input: LocalPromptInput): string {
  const frozen = [LOCAL_PERSONA, LOCAL_RULES, OLLAMA_KANBAN_PROMPT, input.fullCapabilities, input.skillPrompt]
    .filter(Boolean).join('\n\n');

  const bucketProse = input.bucket === 'docs' ? CLAUDE_DOCUMENT_PROMPT : '';

  const v = input.volatiles;
  const volatileBlocks = [
    v.platformNote, v.voiceHint, v.mfgHint, v.uploadsManifest,
    v.deliverableReminder, v.simulationScaffolding, v.continuityAppend,
    v.languageHint, v.languageOverride,
  ].filter(Boolean).join('\n\n');

  return [
    frozen,
    bucketProse,
    volatileBlocks ? `## This turn\n${volatileBlocks}` : '',
  ].filter(Boolean).join('\n\n');
}
