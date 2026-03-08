import { describe, it, expect } from 'vitest';
import {
  isDocGenResponse,
  parseDocGenResponse,
  stripDocGenBlock,
  generateDocument,
  renderChartToPNG,
  type DocGenRequest,
  type ChartSpec,
} from '../src/docgen.js';

describe('DocGen detection', () => {
  it('detects a valid docgen JSON block', () => {
    const text = 'Here is your file:\n```json\n{"format":"xlsx","filename":"test.xlsx","content":{"type":"spreadsheet","sheets":[]}}\n```';
    expect(isDocGenResponse(text)).toBe(true);
  });

  it('does not detect regular JSON blocks', () => {
    const text = '```json\n{"key":"value"}\n```';
    expect(isDocGenResponse(text)).toBe(false);
  });

  it('does not detect plain text', () => {
    expect(isDocGenResponse('Hello world')).toBe(false);
  });
});

describe('parseDocGenResponse', () => {
  it('extracts valid DocGenRequest', () => {
    const json = JSON.stringify({
      format: 'xlsx',
      filename: 'report.xlsx',
      content: {
        type: 'spreadsheet',
        sheets: [{ name: 'Sheet1', headers: ['A', 'B'], rows: [['1', '2']] }],
      },
    });
    const text = `Here:\n\`\`\`json\n${json}\n\`\`\``;
    const result = parseDocGenResponse(text);
    expect(result).not.toBeNull();
    expect(result!.format).toBe('xlsx');
    expect(result!.filename).toBe('report.xlsx');
  });

  it('returns null for malformed JSON', () => {
    const text = '```json\n{invalid}\n```';
    expect(parseDocGenResponse(text)).toBeNull();
  });

  it('returns null for missing required fields', () => {
    const text = '```json\n{"format":"xlsx"}\n```';
    expect(parseDocGenResponse(text)).toBeNull();
  });

  it('returns null for unsupported format', () => {
    const json = JSON.stringify({
      format: 'txt',
      filename: 'test.txt',
      content: { type: 'document', sections: [] },
    });
    const text = `\`\`\`json\n${json}\n\`\`\``;
    expect(parseDocGenResponse(text)).toBeNull();
  });
});

describe('stripDocGenBlock', () => {
  it('removes the JSON block and preserves surrounding text', () => {
    const json = JSON.stringify({
      format: 'csv',
      filename: 'data.csv',
      content: { type: 'spreadsheet', sheets: [] },
    });
    const text = `Before text\n\`\`\`json\n${json}\n\`\`\`\nAfter text`;
    const result = stripDocGenBlock(text);
    expect(result).toContain('Before text');
    expect(result).toContain('After text');
    expect(result).not.toContain('format');
  });
});

describe('generateDocument', () => {
  it('generates CSV from spreadsheet content', async () => {
    const req: DocGenRequest = {
      format: 'csv',
      filename: 'test.csv',
      content: {
        type: 'spreadsheet',
        sheets: [{
          name: 'Sheet1',
          headers: ['Name', 'Age'],
          rows: [['Alice', 30], ['Bob', 25]],
        }],
      },
    };

    const result = await generateDocument(req);
    expect(result.filename).toBe('test.csv');
    expect(result.mimeType).toBe('text/csv');
    expect(result.buffer.toString()).toContain('Name,Age');
    expect(result.buffer.toString()).toContain('Alice,30');
  });

  it('generates XLSX buffer', async () => {
    const req: DocGenRequest = {
      format: 'xlsx',
      filename: 'test.xlsx',
      content: {
        type: 'spreadsheet',
        sheets: [{
          name: 'Data',
          headers: ['ID', 'Value'],
          rows: [[1, 'Hello'], [2, 'World']],
        }],
      },
    };

    const result = await generateDocument(req);
    expect(result.filename).toBe('test.xlsx');
    expect(result.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(result.buffer.length).toBeGreaterThan(0);
    // XLSX files start with PK (zip format)
    expect(result.buffer[0]).toBe(0x50);
    expect(result.buffer[1]).toBe(0x4B);
  });

  it('generates PDF buffer', async () => {
    const req: DocGenRequest = {
      format: 'pdf',
      filename: 'report.pdf',
      title: 'Test Report',
      content: {
        type: 'document',
        sections: [{
          heading: 'Introduction',
          paragraphs: ['This is a test document.'],
          bulletPoints: ['Point 1', 'Point 2'],
        }],
      },
    };

    const result = await generateDocument(req);
    expect(result.filename).toBe('report.pdf');
    expect(result.mimeType).toBe('application/pdf');
    expect(result.buffer.length).toBeGreaterThan(0);
    // PDF files start with %PDF
    expect(result.buffer.toString('ascii', 0, 4)).toBe('%PDF');
  });

  it('generates DOCX buffer', async () => {
    const req: DocGenRequest = {
      format: 'docx',
      filename: 'doc.docx',
      title: 'Test Doc',
      content: {
        type: 'document',
        sections: [{
          heading: 'Section 1',
          paragraphs: ['Paragraph text.'],
        }],
      },
    };

    const result = await generateDocument(req);
    expect(result.filename).toBe('doc.docx');
    expect(result.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(result.buffer.length).toBeGreaterThan(0);
    // DOCX is also a zip
    expect(result.buffer[0]).toBe(0x50);
    expect(result.buffer[1]).toBe(0x4B);
  });

  it('handles document content with tables', async () => {
    const req: DocGenRequest = {
      format: 'csv',
      filename: 'table.csv',
      content: {
        type: 'document',
        sections: [{
          heading: 'Data',
          table: {
            headers: ['X', 'Y'],
            rows: [[1, 2], [3, 4]],
          },
        }],
      },
    };

    const result = await generateDocument(req);
    const csv = result.buffer.toString();
    expect(csv).toContain('X,Y');
    expect(csv).toContain('1,2');
  });

  it('escapes CSV values with commas', async () => {
    const req: DocGenRequest = {
      format: 'csv',
      filename: 'escaped.csv',
      content: {
        type: 'spreadsheet',
        sheets: [{
          name: 'Sheet1',
          headers: ['Name', 'Address'],
          rows: [['Alice', 'New York, NY']],
        }],
      },
    };

    const result = await generateDocument(req);
    const csv = result.buffer.toString();
    expect(csv).toContain('"New York, NY"');
  });
});

// ── Chart rendering tests ─────────────────────────────────────

const barChart: ChartSpec = {
  type: 'bar',
  title: 'Test Bar Chart',
  data: {
    labels: ['A', 'B', 'C'],
    datasets: [{
      label: 'Values',
      data: [10, 20, 30],
      backgroundColor: ['#FF6384', '#36A2EB', '#FFCE56'],
    }],
  },
};

describe('renderChartToPNG', () => {
  it('produces a valid PNG buffer', async () => {
    const png = await renderChartToPNG(barChart);
    expect(png).toBeInstanceOf(Buffer);
    expect(png.length).toBeGreaterThan(100);
    // PNG magic bytes: 0x89 P N G
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
    expect(png[2]).toBe(0x4E);
    expect(png[3]).toBe(0x47);
  });

  it('renders line chart without errors', async () => {
    const spec: ChartSpec = {
      type: 'line',
      data: {
        labels: ['Jan', 'Feb', 'Mar'],
        datasets: [{ label: 'Sales', data: [5, 15, 10] }],
      },
    };
    const png = await renderChartToPNG(spec);
    expect(png[0]).toBe(0x89);
  });

  it('renders pie chart without errors', async () => {
    const spec: ChartSpec = {
      type: 'pie',
      title: 'Distribution',
      data: {
        labels: ['X', 'Y', 'Z'],
        datasets: [{ data: [30, 50, 20], backgroundColor: ['#f00', '#0f0', '#00f'] }],
      },
    };
    const png = await renderChartToPNG(spec);
    expect(png[0]).toBe(0x89);
  });
});

describe('generateDocument with charts', () => {
  it('generates PDF with chart section', async () => {
    const req: DocGenRequest = {
      format: 'pdf',
      filename: 'chart-report.pdf',
      title: 'Chart Report',
      content: {
        type: 'document',
        sections: [{
          heading: 'Results',
          paragraphs: ['See chart below:'],
          chart: barChart,
        }],
      },
    };

    const result = await generateDocument(req);
    expect(result.filename).toBe('chart-report.pdf');
    expect(result.mimeType).toBe('application/pdf');
    expect(result.buffer.toString('ascii', 0, 4)).toBe('%PDF');
    // PDF with chart should be larger than a text-only PDF
    expect(result.buffer.length).toBeGreaterThan(1000);
  });

  it('generates DOCX with chart section', async () => {
    const req: DocGenRequest = {
      format: 'docx',
      filename: 'chart-doc.docx',
      title: 'Chart Doc',
      content: {
        type: 'document',
        sections: [{
          heading: 'Overview',
          chart: barChart,
        }],
      },
    };

    const result = await generateDocument(req);
    expect(result.filename).toBe('chart-doc.docx');
    expect(result.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    // DOCX is a zip
    expect(result.buffer[0]).toBe(0x50);
    expect(result.buffer[1]).toBe(0x4B);
  });
});
