import type { Tool } from 'ollama';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { generateDocument, type DocGenRequest } from '../../docgen.js';
import { UPLOADS_DIR } from '../../config.js';

export const generateDocumentDefinition: Tool = {
  type: 'function',
  function: {
    name: 'generate_document',
    description:
      'Generate a formatted document file (XLSX, DOCX, PDF, or CSV) and save it for sending to the user. Use when the user asks you to create a spreadsheet, report, document, or export data.',
    parameters: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['xlsx', 'docx', 'pdf', 'csv'],
          description: 'Output format',
        },
        filename: {
          type: 'string',
          description: 'Desired filename (e.g., "report.xlsx")',
        },
        title: {
          type: 'string',
          description: 'Document title (optional)',
        },
        content: {
          type: 'object',
          description:
            'Content object. For spreadsheets: { type: "spreadsheet", sheets: [{ name, headers, rows }] }. For documents: { type: "document", sections: [{ heading?, paragraphs?, bulletPoints?, table?: { headers, rows }, chart?: { type: "bar"|"line"|"pie"|"doughnut"|"scatter"|"radar"|"bubble"|"polarArea", title?, data: { labels?, datasets: [{ label?, data, backgroundColor?, borderColor? }] } } }] }',
        },
      },
      required: ['format', 'filename', 'content'],
    },
  },
};

export async function generateDocumentTool(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const req: DocGenRequest = {
      format: args.format as DocGenRequest['format'],
      filename: args.filename as string,
      title: args.title as string | undefined,
      content: args.content as DocGenRequest['content'],
    };

    const result = await generateDocument(req);

    // Save to uploads directory
    mkdirSync(UPLOADS_DIR, { recursive: true });
    const filePath = resolve(UPLOADS_DIR, `${Date.now()}_${req.filename}`);
    writeFileSync(filePath, result.buffer);

    return {
      __docgen: true,
      path: filePath,
      filename: result.filename,
      mimeType: result.mimeType,
      size: result.buffer.length,
      success: true,
      message: `Document "${result.filename}" (${result.mimeType}, ${result.buffer.length} bytes) has been generated and will be sent to the user automatically. Do NOT call generate_document again for this request.`,
    };
  } catch (err) {
    return {
      error: `Document generation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
