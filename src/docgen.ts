import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────

export interface SpreadsheetContent {
  type: 'spreadsheet';
  sheets: Array<{
    name: string;
    headers: string[];
    rows: (string | number | boolean | null)[][];
  }>;
}

export interface ChartSpec {
  type: 'bar' | 'line' | 'pie' | 'doughnut' | 'scatter' | 'radar' | 'bubble' | 'polarArea';
  title?: string;
  data: {
    labels?: string[];
    datasets: Array<{
      label?: string;
      data: (number | { x: number; y: number; r?: number })[];
      backgroundColor?: string | string[];
      borderColor?: string | string[];
      pointRadius?: number;
      pointBackgroundColor?: string | string[];
      showLine?: boolean;
      [key: string]: unknown;
    }>;
  };
  options?: Record<string, unknown>;
}

export interface DocumentSection {
  heading?: string;
  paragraphs?: string[];
  bulletPoints?: string[];
  table?: {
    headers: string[];
    rows: (string | number)[][];
  };
  chart?: ChartSpec;
}

export interface DocumentContent {
  type: 'document';
  sections: DocumentSection[];
}

export interface SlideSpec {
  layout: 'title' | 'bullets' | 'two-column' | 'image' | 'chart' | 'blank';
  title?: string;
  subtitle?: string;
  bullets?: string[];
  body?: string;
  leftColumn?: string[];
  rightColumn?: string[];
  imageUrl?: string;
  chart?: ChartSpec;
  notes?: string;
}

export interface PresentationContent {
  type: 'presentation';
  slides: SlideSpec[];
}

export interface DocGenRequest {
  format: 'xlsx' | 'docx' | 'pdf' | 'csv' | 'pptx';
  filename: string;
  title?: string;
  content: SpreadsheetContent | DocumentContent | PresentationContent;
}

/** Type guard helpers for content discrimination. */
function isSpreadsheet(c: DocGenRequest['content']): c is SpreadsheetContent {
  return c.type === 'spreadsheet';
}
function isDocument(c: DocGenRequest['content']): c is DocumentContent {
  return c.type === 'document';
}
function isPresentation(c: DocGenRequest['content']): c is PresentationContent {
  return c.type === 'presentation';
}

export interface DocGenResult {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

// ── Detection ────────────────────────────────────────────────

const DOCGEN_JSON_REGEX = /```(?:json)?\s*(\{[\s\S]*?"format"\s*:\s*"(?:xlsx|docx|pdf|csv|pptx)"[\s\S]*?\})\s*```/;

/**
 * Quick check if AI response contains a document generation request.
 */
export function isDocGenResponse(text: string): boolean {
  return DOCGEN_JSON_REGEX.test(text);
}

/**
 * Extract and parse a DocGenRequest from AI response text.
 */
export function parseDocGenResponse(text: string): DocGenRequest | null {
  const match = text.match(DOCGEN_JSON_REGEX);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed.format || !parsed.content || !parsed.filename) return null;
    if (!['xlsx', 'docx', 'pdf', 'csv', 'pptx'].includes(parsed.format)) return null;
    return parsed as DocGenRequest;
  } catch {
    return null;
  }
}

/**
 * Remove the JSON code block from the AI response text,
 * returning the remaining message text.
 */
export function stripDocGenBlock(text: string): string {
  return text.replace(DOCGEN_JSON_REGEX, '').trim();
}

// ── PDF Text Sanitization ───────────────────────────────────

/**
 * Strip emoji and other characters that Helvetica cannot render.
 * Keeps basic Latin, Latin-1 Supplement, and common punctuation.
 */
function sanitizePdfText(text: string): string {
  // Remove emoji and symbols outside Basic Latin + Latin-1 Supplement
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{200D}]|[\u{20E3}]|[\u{E0020}-\u{E007F}]/gu, '').trim();
}

// ── Chart Rendering ─────────────────────────────────────────

export async function renderChartToPNG(spec: ChartSpec): Promise<Buffer> {
  const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');

  const chartCanvas = new ChartJSNodeCanvas({
    width: 800,
    height: 500,
    backgroundColour: 'white',
  });

  // Normalize scatter/bubble data: ensure {x,y} point format
  const normalizedData = { ...spec.data };
  if (spec.type === 'scatter' || spec.type === 'bubble') {
    normalizedData.datasets = spec.data.datasets.map(ds => ({
      ...ds,
      data: ds.data.map(point => {
        if (typeof point === 'number') return { x: point, y: point };
        return point;
      }),
      // Ensure scatter/bubble points are visible
      pointRadius: ds.pointRadius ?? (spec.type === 'bubble' ? undefined : 6),
      pointBackgroundColor: ds.pointBackgroundColor ?? ds.backgroundColor ?? '#36A2EB',
      showLine: ds.showLine ?? (spec.type === 'scatter' ? false : undefined),
    }));
  }

  // Build scale options for point-based charts
  const needsLinearAxes = spec.type === 'scatter' || spec.type === 'bubble';
  const scalesConfig = needsLinearAxes
    ? {
        x: { type: 'linear' as const, position: 'bottom' as const, ...((spec.options?.scales as Record<string, unknown>)?.x as Record<string, unknown> ?? {}) },
        y: { type: 'linear' as const, ...((spec.options?.scales as Record<string, unknown>)?.y as Record<string, unknown> ?? {}) },
      }
    : (spec.options?.scales ?? undefined);

  const config = {
    type: spec.type as import('chart.js').ChartType,
    data: normalizedData as import('chart.js').ChartData,
    options: {
      ...(spec.options ?? {}),
      animation: false as const,
      devicePixelRatio: 2,
      layout: {
        padding: 10,
        ...((spec.options?.layout as Record<string, unknown>) ?? {}),
      },
      scales: scalesConfig,
      plugins: {
        ...((spec.options?.plugins as Record<string, unknown>) ?? {}),
        title: spec.title
          ? { display: true, text: spec.title, font: { size: 16 } }
          : undefined,
      },
    },
  };

  return Buffer.from(await chartCanvas.renderToBuffer(config as import('chart.js').ChartConfiguration));
}

// ── Generators ───────────────────────────────────────────────

export async function generateDocument(req: DocGenRequest): Promise<DocGenResult> {
  switch (req.format) {
    case 'xlsx':
      return { buffer: await generateXlsx(req), filename: req.filename, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    case 'docx':
      return { buffer: await generateDocx(req), filename: req.filename, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    case 'pdf':
      return { buffer: await generatePdf(req), filename: req.filename, mimeType: 'application/pdf' };
    case 'csv':
      return { buffer: Buffer.from(generateCsvString(req), 'utf-8'), filename: req.filename, mimeType: 'text/csv' };
    case 'pptx':
      return { buffer: await generatePptx(req), filename: req.filename, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
    default:
      throw new Error(`Unsupported format: ${req.format}`);
  }
}

async function generateXlsx(req: DocGenRequest): Promise<Buffer> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.default.Workbook();

  if (isSpreadsheet(req.content)) {
    for (const sheet of req.content.sheets) {
      const ws = workbook.addWorksheet(sheet.name);

      // Headers
      ws.addRow(sheet.headers);
      const headerRow = ws.getRow(1);
      headerRow.font = { bold: true };

      // Data rows
      for (const row of sheet.rows) {
        ws.addRow(row);
      }

      // Auto-size columns (approximate)
      ws.columns.forEach((col) => {
        let maxLen = 10;
        col.eachCell?.({ includeEmpty: false }, (cell) => {
          const len = String(cell.value ?? '').length;
          if (len > maxLen) maxLen = len;
        });
        col.width = Math.min(maxLen + 2, 50);
      });
    }
  } else if (isDocument(req.content)) {
    // Document content → single sheet with sections
    const ws = workbook.addWorksheet(req.title || 'Document');
    for (const section of req.content.sections) {
      if (section.heading) {
        const row = ws.addRow([section.heading]);
        row.font = { bold: true, size: 14 };
        ws.addRow([]);
      }
      if (section.table) {
        ws.addRow(section.table.headers).font = { bold: true };
        for (const row of section.table.rows) {
          ws.addRow(row);
        }
        ws.addRow([]);
      }
      if (section.paragraphs) {
        for (const p of section.paragraphs) {
          ws.addRow([p]);
        }
        ws.addRow([]);
      }
      if (section.bulletPoints) {
        for (const b of section.bulletPoints) {
          ws.addRow([`• ${b}`]);
        }
        ws.addRow([]);
      }
    }
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

async function generateDocx(req: DocGenRequest): Promise<Buffer> {
  const { Paragraph, Table, TableRow, TableCell, Document, Packer, HeadingLevel, WidthType, ImageRun } = await import('docx');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const children: any[] = [];

  if (req.title) {
    children.push(
      new Paragraph({
        text: req.title,
        heading: HeadingLevel.TITLE,
        spacing: { after: 200 },
      }),
    );
  }

  function buildTableRows(
    headers: string[],
    rows: (string | number | boolean | null)[][],
  ) {
    const result = [
      new TableRow({
        tableHeader: true,
        children: headers.map(
          (h) =>
            new TableCell({
              children: [new Paragraph({ text: String(h), run: { bold: true } })],
            }),
        ),
      }),
    ];

    for (const row of rows) {
      result.push(
        new TableRow({
          children: row.map(
            (cell) =>
              new TableCell({
                children: [new Paragraph({ text: String(cell ?? '') })],
              }),
          ),
        }),
      );
    }

    return result;
  }

  if (isDocument(req.content)) {
    for (const section of req.content.sections) {
      if (section.heading) {
        children.push(
          new Paragraph({
            text: section.heading,
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 200, after: 100 },
          }),
        );
      }

      if (section.paragraphs) {
        for (const p of section.paragraphs) {
          children.push(new Paragraph({ text: p, spacing: { after: 100 } }));
        }
      }

      if (section.bulletPoints) {
        for (const b of section.bulletPoints) {
          children.push(
            new Paragraph({
              text: b,
              bullet: { level: 0 },
              spacing: { after: 50 },
            }),
          );
        }
      }

      if (section.table) {
        children.push(
          new Table({
            rows: buildTableRows(section.table.headers, section.table.rows),
            width: { size: 100, type: WidthType.PERCENTAGE },
          }),
        );
      }

      if (section.chart) {
        try {
          const chartPng = await renderChartToPNG(section.chart);
          children.push(
            new Paragraph({
              children: [
                new ImageRun({
                  data: chartPng,
                  transformation: { width: 600, height: 375 },
                  type: 'png',
                }),
              ],
              spacing: { before: 100, after: 100 },
            }),
          );
        } catch (err) {
          logger.warn({ err }, 'Chart rendering failed in DOCX, skipping');
          children.push(new Paragraph({ text: '[Chart could not be rendered]' }));
        }
      }
    }
  } else if (isSpreadsheet(req.content)) {
    for (const sheet of req.content.sheets) {
      children.push(
        new Paragraph({
          text: sheet.name,
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 200, after: 100 },
        }),
      );

      children.push(
        new Table({
          rows: buildTableRows(sheet.headers, sheet.rows),
          width: { size: 100, type: WidthType.PERCENTAGE },
        }),
      );
    }
  }

  const doc = new Document({
    sections: [{ children }],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}

async function generatePdf(req: DocGenRequest): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;

  // Pre-render all charts before entering the synchronous PDF stream
  const chartBuffers = new Map<number, Buffer>();
  if (isDocument(req.content)) {
    for (let i = 0; i < req.content.sections.length; i++) {
      const section = req.content.sections[i];
      if (section.chart) {
        try {
          chartBuffers.set(i, await renderChartToPNG(section.chart));
        } catch (err) {
          logger.warn({ err }, 'Chart rendering failed in PDF, skipping');
        }
      }
    }
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Title
    if (req.title) {
      doc.fontSize(20).font('Helvetica-Bold').text(sanitizePdfText(req.title));
      doc.moveDown();
    }

    if (isDocument(req.content)) {
      for (let i = 0; i < req.content.sections.length; i++) {
        const section = req.content.sections[i];
        if (section.heading) {
          doc.fontSize(14).font('Helvetica-Bold').text(sanitizePdfText(section.heading));
          doc.moveDown(0.5);
        }

        if (section.paragraphs) {
          doc.fontSize(10).font('Helvetica');
          for (const p of section.paragraphs) {
            doc.text(sanitizePdfText(p));
            doc.moveDown(0.3);
          }
        }

        if (section.bulletPoints) {
          doc.fontSize(10).font('Helvetica');
          for (const b of section.bulletPoints) {
            doc.text(`  • ${sanitizePdfText(b)}`, { indent: 20 });
          }
          doc.moveDown(0.5);
        }

        if (section.table) {
          drawPdfTable(doc, section.table.headers, section.table.rows);
          doc.moveDown();
        }

        const chartPng = chartBuffers.get(i);
        if (chartPng) {
          // Chart rendered at 800x500 (ratio 1.6), displayed at width 500 → height ~312
          const chartDisplayHeight = 312;
          const pageBottom = doc.page.height - doc.page.margins.bottom;
          if (doc.y + chartDisplayHeight > pageBottom) {
            doc.addPage();
          }
          doc.image(chartPng, { width: 500 });
          doc.moveDown();
        } else if (section.chart && !chartPng) {
          doc.fontSize(10).font('Helvetica').text('[Chart could not be rendered]');
          doc.moveDown();
        }
      }
    } else if (isSpreadsheet(req.content)) {
      for (const sheet of req.content.sheets) {
        doc.fontSize(14).font('Helvetica-Bold').text(sanitizePdfText(sheet.name));
        doc.moveDown(0.5);
        drawPdfTable(doc, sheet.headers, sheet.rows);
        doc.moveDown();
      }
    }

    doc.end();
  });
}

function drawPdfTable(
  doc: PDFKit.PDFDocument,
  headers: string[],
  rows: (string | number | boolean | null)[][],
): void {
  const margins = doc.page.margins;
  const tableWidth = doc.page.width - margins.left - margins.right;
  const colWidth = tableWidth / headers.length;
  const startX = margins.left;
  const cellPad = 3;
  const maxY = doc.page.height - margins.bottom;

  // Measure the tallest cell in a row to determine row height
  function measureRowHeight(cells: string[], font: string, size: number): number {
    doc.font(font).fontSize(size);
    let max = 0;
    for (const text of cells) {
      const h = doc.heightOfString(text, { width: colWidth - cellPad * 2 });
      if (h > max) max = h;
    }
    return max + cellPad * 2;
  }

  // Render a single row at current doc.y, advance doc.y by the row height
  function renderRow(cells: string[], font: string, size: number, underline: boolean): void {
    const y = doc.y;
    const h = measureRowHeight(cells, font, size);
    doc.font(font).fontSize(size);
    for (let i = 0; i < cells.length; i++) {
      doc.text(cells[i], startX + i * colWidth + cellPad, y + cellPad, {
        width: colWidth - cellPad * 2,
        height: h, // constrain to measured height — prevents auto-pagination
      });
    }
    if (underline) {
      doc.moveTo(startX, y + h).lineTo(startX + tableWidth, y + h).stroke();
    }
    doc.x = startX;
    doc.y = y + h;
  }

  // Header row with underline
  function drawHeaders(): void {
    renderRow(headers.map((h) => sanitizePdfText(String(h))), 'Helvetica-Bold', 9, true);
  }

  drawHeaders();

  for (const row of rows) {
    const cells = row.map((c) => sanitizePdfText(String(c ?? '')));
    const h = measureRowHeight(cells, 'Helvetica', 9);

    // If this row won't fit, start a new page and re-render headers
    if (doc.y + h > maxY) {
      doc.addPage();
      drawHeaders();
    }

    renderRow(cells, 'Helvetica', 9, false);
  }

  doc.x = startX;
}

async function generatePptx(req: DocGenRequest): Promise<Buffer> {
  const pptxModule = await import('pptxgenjs');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const PptxGenJS = (pptxModule.default ?? pptxModule) as any;
  const pptx = new PptxGenJS();

  // Dark professional theme
  const BG_COLOR = '1a1a2e';
  const TEXT_COLOR = 'e0e0e8';
  const ACCENT_COLOR = '58a6ff';
  const DIM_COLOR = '8b949e';

  pptx.layout = 'LAYOUT_WIDE'; // 13.33" x 7.5"
  pptx.author = 'Luna';
  if (req.title) pptx.title = req.title;

  // Determine slides from content
  let slides: SlideSpec[] = [];

  if (req.content.type === 'presentation') {
    slides = req.content.slides;
  } else if (req.content.type === 'document') {
    // Convert document sections to slides
    if (req.title) {
      slides.push({ layout: 'title', title: req.title });
    }
    for (const section of req.content.sections) {
      const slide: SlideSpec = { layout: 'bullets' };
      if (section.heading) slide.title = section.heading;
      if (section.bulletPoints) slide.bullets = section.bulletPoints;
      else if (section.paragraphs) slide.bullets = section.paragraphs;
      if (section.chart) { slide.layout = 'chart'; slide.chart = section.chart; }
      slides.push(slide);
    }
  }

  for (const spec of slides) {
    const slide = pptx.addSlide();
    slide.background = { color: BG_COLOR };

    if (spec.notes) {
      slide.addNotes(spec.notes);
    }

    switch (spec.layout) {
      case 'title': {
        slide.addText(spec.title || '', {
          x: 0.5, y: 2.0, w: 12.3, h: 1.5,
          fontSize: 36, fontFace: 'Helvetica',
          color: TEXT_COLOR, bold: true, align: 'center',
        });
        if (spec.subtitle) {
          slide.addText(spec.subtitle, {
            x: 0.5, y: 3.8, w: 12.3, h: 1.0,
            fontSize: 18, fontFace: 'Helvetica',
            color: DIM_COLOR, align: 'center',
          });
        }
        // Accent line
        slide.addShape('rect' as unknown as Parameters<typeof slide.addShape>[0], {
          x: 4.0, y: 3.5, w: 5.3, h: 0.04,
          fill: { color: ACCENT_COLOR },
        });
        break;
      }

      case 'bullets': {
        if (spec.title) {
          slide.addText(spec.title, {
            x: 0.5, y: 0.3, w: 12.3, h: 0.8,
            fontSize: 24, fontFace: 'Helvetica',
            color: TEXT_COLOR, bold: true,
          });
          // Accent underline
          slide.addShape('rect' as unknown as Parameters<typeof slide.addShape>[0], {
            x: 0.5, y: 1.05, w: 3.0, h: 0.03,
            fill: { color: ACCENT_COLOR },
          });
        }
        if (spec.bullets && spec.bullets.length > 0) {
          const bulletText = spec.bullets.map((b) => ({
            text: b,
            options: { fontSize: 16, color: TEXT_COLOR, bullet: { code: '2022' }, breakType: 'none' as const },
          }));
          slide.addText(bulletText as Parameters<typeof slide.addText>[0], {
            x: 0.8, y: 1.4, w: 11.5, h: 5.5,
            fontFace: 'Helvetica', paraSpaceAfter: 8,
            valign: 'top',
          });
        }
        if (spec.body) {
          slide.addText(spec.body, {
            x: 0.8, y: 1.4, w: 11.5, h: 5.5,
            fontSize: 16, fontFace: 'Helvetica',
            color: TEXT_COLOR, valign: 'top',
          });
        }
        break;
      }

      case 'two-column': {
        if (spec.title) {
          slide.addText(spec.title, {
            x: 0.5, y: 0.3, w: 12.3, h: 0.8,
            fontSize: 24, fontFace: 'Helvetica',
            color: TEXT_COLOR, bold: true,
          });
        }
        if (spec.leftColumn) {
          const leftText = spec.leftColumn.map((b) => ({
            text: b,
            options: { fontSize: 14, color: TEXT_COLOR, bullet: { code: '2022' }, breakType: 'none' as const },
          }));
          slide.addText(leftText as Parameters<typeof slide.addText>[0], {
            x: 0.5, y: 1.4, w: 5.8, h: 5.5,
            fontFace: 'Helvetica', paraSpaceAfter: 6, valign: 'top',
          });
        }
        if (spec.rightColumn) {
          const rightText = spec.rightColumn.map((b) => ({
            text: b,
            options: { fontSize: 14, color: TEXT_COLOR, bullet: { code: '2022' }, breakType: 'none' as const },
          }));
          slide.addText(rightText as Parameters<typeof slide.addText>[0], {
            x: 7.0, y: 1.4, w: 5.8, h: 5.5,
            fontFace: 'Helvetica', paraSpaceAfter: 6, valign: 'top',
          });
        }
        // Divider line
        slide.addShape('rect' as unknown as Parameters<typeof slide.addShape>[0], {
          x: 6.5, y: 1.4, w: 0.02, h: 5.5,
          fill: { color: '30363d' },
        });
        break;
      }

      case 'chart': {
        if (spec.title) {
          slide.addText(spec.title, {
            x: 0.5, y: 0.3, w: 12.3, h: 0.8,
            fontSize: 24, fontFace: 'Helvetica',
            color: TEXT_COLOR, bold: true,
          });
        }
        if (spec.chart) {
          // Map ChartSpec to pptxgenjs chart
          const chartTypeMap: Record<string, string> = {
            bar: 'bar', line: 'line', pie: 'pie', doughnut: 'doughnut',
            scatter: 'scatter', radar: 'radar', bubble: 'bubble',
          };
          const pptxType = chartTypeMap[spec.chart.type] || 'bar';
          const chartData = spec.chart.data.datasets.map((ds) => ({
            name: ds.label || 'Series',
            labels: spec.chart!.data.labels || [],
            values: ds.data.map((d) => typeof d === 'number' ? d : 0),
          }));

          try {
            slide.addChart(pptxType as Parameters<typeof slide.addChart>[0], chartData as Parameters<typeof slide.addChart>[1], {
              x: 0.5, y: 1.4, w: 12.3, h: 5.5,
              showTitle: !!spec.chart.title,
              title: spec.chart.title || '',
              titleColor: TEXT_COLOR,
              catAxisLabelColor: DIM_COLOR,
              valAxisLabelColor: DIM_COLOR,
              legendColor: TEXT_COLOR,
              chartColors: ['58a6ff', '3fb950', 'd29922', 'f85149', '8b5cf6', 'ec4899'],
            } as Parameters<typeof slide.addChart>[2]);
          } catch (err) {
            logger.warn({ err }, 'PPTX chart failed, adding placeholder');
            slide.addText('[Chart could not be rendered]', {
              x: 0.5, y: 3.0, w: 12.3, h: 1.0,
              fontSize: 16, color: DIM_COLOR, align: 'center',
            });
          }
        }
        break;
      }

      case 'image': {
        if (spec.title) {
          slide.addText(spec.title, {
            x: 0.5, y: 0.3, w: 12.3, h: 0.8,
            fontSize: 24, fontFace: 'Helvetica',
            color: TEXT_COLOR, bold: true,
          });
        }
        if (spec.imageUrl) {
          try {
            if (spec.imageUrl.startsWith('data:')) {
              slide.addImage({ data: spec.imageUrl, x: 1.5, y: 1.4, w: 10.3, h: 5.5 });
            } else {
              slide.addImage({ path: spec.imageUrl, x: 1.5, y: 1.4, w: 10.3, h: 5.5 });
            }
          } catch (err) {
            logger.warn({ err }, 'PPTX image failed');
            slide.addText('[Image could not be loaded]', {
              x: 0.5, y: 3.0, w: 12.3, h: 1.0,
              fontSize: 16, color: DIM_COLOR, align: 'center',
            });
          }
        }
        break;
      }

      case 'blank':
      default:
        // Empty slide — user can add content manually
        break;
    }
  }

  // Write to buffer
  const data = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.from(data as ArrayBuffer);
}

function generateCsvString(req: DocGenRequest): string {
  const escape = (val: unknown): string => {
    const s = String(val ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const lines: string[] = [];

  if (isSpreadsheet(req.content)) {
    // Use first sheet only for CSV
    const sheet = req.content.sheets[0];
    if (sheet) {
      lines.push(sheet.headers.map(escape).join(','));
      for (const row of sheet.rows) {
        lines.push(row.map(escape).join(','));
      }
    }
  } else if (isDocument(req.content)) {
    // For document content, look for tables
    for (const section of req.content.sections) {
      if (section.table) {
        lines.push(section.table.headers.map(escape).join(','));
        for (const row of section.table.rows) {
          lines.push(row.map(escape).join(','));
        }
      }
    }
  }

  return lines.join('\n');
}
