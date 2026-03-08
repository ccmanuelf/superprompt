import { generateDocument, type ChartSpec } from '../src/docgen.js';

async function main() {
  const charts: ChartSpec[] = [
    { type: 'bar', title: 'Bar', data: { labels: ['A', 'B'], datasets: [{ label: 'V', data: [1, 2] }] } },
    { type: 'line', title: 'Line', data: { labels: ['A', 'B'], datasets: [{ label: 'V', data: [1, 2] }] } },
    { type: 'pie', title: 'Pie', data: { labels: ['A', 'B'], datasets: [{ data: [1, 2] }] } },
    { type: 'scatter', title: 'Scatter', data: { datasets: [{ label: 'V', data: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }] } },
    { type: 'bubble', title: 'Bubble', data: { datasets: [{ label: 'V', data: [{ x: 1, y: 2, r: 5 }, { x: 3, y: 4, r: 10 }] }] } },
    { type: 'radar', title: 'Radar', data: { labels: ['A', 'B', 'C'], datasets: [{ label: 'V', data: [1, 2, 3] }] } },
    { type: 'doughnut', title: 'Doughnut', data: { labels: ['A', 'B'], datasets: [{ data: [1, 2] }] } },
    { type: 'polarArea', title: 'Polar', data: { labels: ['A', 'B'], datasets: [{ data: [1, 2] }] } },
  ];

  console.log(`Generating DOCX with ${charts.length} chart sections...`);
  const start = Date.now();
  const result = await generateDocument({
    format: 'docx',
    filename: 'multi-chart.docx',
    title: 'Multi-Chart Test',
    content: {
      type: 'document',
      sections: charts.map((chart, i) => ({
        heading: `Section ${i + 1}: ${chart.title}`,
        paragraphs: [`This is a ${chart.type} chart.`],
        chart,
      })),
    },
  });
  console.log(`DOCX done in ${Date.now() - start}ms, size: ${result.buffer.length}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
