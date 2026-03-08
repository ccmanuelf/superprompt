import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { logger } from './logger.js';

const MAX_CHARS = 50_000;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export interface ParsedFile {
  text: string;
  format: string;
  pageCount?: number;
  sheetCount?: number;
  truncated: boolean;
  error?: string;
}

/**
 * Parse a file and extract its text content.
 * Supports: xlsx, docx, pdf, csv, json, md, txt, pptx.
 * Never throws — returns { error } on failure.
 */
export async function parseFile(
  filePath: string,
  mimeType?: string,
): Promise<ParsedFile> {
  try {
    // File size guard
    const stat = statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      return {
        text: '',
        format: 'unknown',
        truncated: false,
        error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Maximum is 50MB.`,
      };
    }

    const ext = extname(filePath).toLowerCase().replace('.', '');
    const format = resolveFormat(ext, mimeType);

    switch (format) {
      case 'xlsx':
        return await parseXlsx(filePath);
      case 'docx':
        return await parseDocx(filePath);
      case 'pdf':
        return await parsePdf(filePath);
      case 'csv':
        return await parseCsv(filePath);
      case 'json':
        return parseJson(filePath);
      case 'md':
      case 'txt':
        return parsePlainText(filePath, format);
      case 'pptx':
        return await parsePptx(filePath);
      default:
        return {
          text: '',
          format: ext || 'unknown',
          truncated: false,
          error: `Unsupported file format: ${ext || mimeType || 'unknown'}`,
        };
    }
  } catch (err) {
    logger.error({ err, filePath }, 'File parsing failed');
    return {
      text: '',
      format: 'unknown',
      truncated: false,
      error: `Failed to parse file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function resolveFormat(ext: string, mimeType?: string): string {
  // Extension-based mapping
  const extMap: Record<string, string> = {
    xlsx: 'xlsx', xls: 'xlsx',
    docx: 'docx', doc: 'docx',
    pdf: 'pdf',
    csv: 'csv', tsv: 'csv',
    json: 'json',
    md: 'md', markdown: 'md',
    txt: 'txt', text: 'txt', log: 'txt',
    pptx: 'pptx', ppt: 'pptx',
  };

  if (extMap[ext]) return extMap[ext];

  // MIME-based fallback
  if (mimeType) {
    const mimeMap: Record<string, string> = {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/vnd.ms-excel': 'xlsx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/msword': 'docx',
      'application/pdf': 'pdf',
      'text/csv': 'csv',
      'application/json': 'json',
      'text/markdown': 'md',
      'text/plain': 'txt',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
      'application/vnd.ms-powerpoint': 'pptx',
    };
    if (mimeMap[mimeType]) return mimeMap[mimeType];
  }

  return ext;
}

function truncateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_CHARS) return { text, truncated: false };
  return {
    text: text.slice(0, MAX_CHARS) + '\n\n[Content truncated at 50,000 characters]',
    truncated: true,
  };
}

async function parseXlsx(filePath: string): Promise<ParsedFile> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.default.Workbook();
  await workbook.xlsx.readFile(filePath);

  const parts: string[] = [];
  let sheetCount = 0;

  workbook.eachSheet((sheet) => {
    sheetCount++;
    parts.push(`=== Sheet: ${sheet.name} ===`);

    sheet.eachRow((row, rowNumber) => {
      const cells = (row.values as unknown[])
        .slice(1) // exceljs row.values is 1-indexed with null at 0
        .map((v) => (v != null ? String(v) : ''));
      parts.push(cells.join('\t'));
    });

    parts.push('');
  });

  const { text, truncated } = truncateText(parts.join('\n'));
  return { text, format: 'xlsx', sheetCount, truncated };
}

async function parseDocx(filePath: string): Promise<ParsedFile> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  const { text, truncated } = truncateText(result.value);
  return { text, format: 'docx', truncated };
}

async function parsePdf(filePath: string): Promise<ParsedFile> {
  const { PDFParse } = await import('pdf-parse');
  const buffer = readFileSync(filePath);
  const parser = new PDFParse({ data: buffer });
  const textResult = await parser.getText();
  const pageCount = textResult.total;
  const allText = textResult.text;

  await parser.destroy();
  const { text, truncated } = truncateText(allText);
  return { text, format: 'pdf', pageCount, truncated };
}

async function parseCsv(filePath: string): Promise<ParsedFile> {
  const { parse } = await import('csv-parse/sync');
  const content = readFileSync(filePath, 'utf-8');

  const records = parse(content, {
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  }) as string[][];

  const text = records.map((row) => row.join('\t')).join('\n');
  const { text: result, truncated } = truncateText(text);
  return { text: result, format: 'csv', truncated };
}

function parseJson(filePath: string): ParsedFile {
  const content = readFileSync(filePath, 'utf-8');
  try {
    const data = JSON.parse(content);
    const formatted = JSON.stringify(data, null, 2);
    const { text, truncated } = truncateText(formatted);
    return { text, format: 'json', truncated };
  } catch {
    // Not valid JSON, return raw
    const { text, truncated } = truncateText(content);
    return { text, format: 'json', truncated };
  }
}

function parsePlainText(filePath: string, format: string): ParsedFile {
  const content = readFileSync(filePath, 'utf-8');
  const { text, truncated } = truncateText(content);
  return { text, format, truncated };
}

async function parsePptx(filePath: string): Promise<ParsedFile> {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();

  // Extract text from slide XML files
  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));

  const parts: string[] = [];
  for (const entry of slideEntries) {
    const xml = entry.getData().toString('utf-8');
    // Strip XML tags to get text content
    const text = xml
      .replace(/<a:t>([^<]*)<\/a:t>/g, '$1 ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) {
      const slideNum = entry.entryName.match(/slide(\d+)/)?.[1] || '?';
      parts.push(`--- Slide ${slideNum} ---\n${text}`);
    }
  }

  const { text, truncated } = truncateText(parts.join('\n\n'));
  return { text, format: 'pptx', truncated };
}
