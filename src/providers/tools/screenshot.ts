import type { Tool } from 'ollama';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { WORKSPACE_DIR } from '../../config.js';
import { logger } from '../../logger.js';

/**
 * Screenshot tool — captures a web page using Puppeteer.
 *
 * Returns the file path to the captured screenshot image.
 * The platform handler sends it via sendPhoto (Telegram) or file upload (Matrix).
 *
 * Requires Puppeteer + Chromium installed in the Docker container.
 * Gracefully degrades if Puppeteer is not available.
 */

const SCREENSHOT_DIR = resolve(WORKSPACE_DIR, 'screenshots');
const SCREENSHOT_TIMEOUT_MS = 30_000;

export const takeScreenshotDefinition: Tool = {
  type: 'function',
  function: {
    name: 'take_screenshot',
    description:
      'Take a screenshot of a web page. Returns the image file path. Use this to verify deployed changes, preview websites, or capture visual state. The screenshot will be sent as an image in the chat.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to screenshot (e.g., "https://your-app.onrender.com")',
        },
        selector: {
          type: 'string',
          description: 'Optional CSS selector to capture a specific element instead of the full page',
        },
        fullPage: {
          type: 'boolean',
          description: 'Capture the full scrollable page (default: false, captures viewport only)',
        },
      },
      required: ['url'],
    },
  },
};

export async function takeScreenshot(args: {
  url: string;
  selector?: string;
  fullPage?: boolean;
}): Promise<Record<string, unknown>> {
  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(args.url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { error: 'Only http and https URLs are supported.' };
    }
  } catch {
    return { error: `Invalid URL: ${args.url}` };
  }

  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const filename = `screenshot-${randomBytes(4).toString('hex')}.png`;
  const filepath = resolve(SCREENSHOT_DIR, filename);

  // Dynamic import for graceful degradation when puppeteer-core is not installed
  let launch: (opts: Record<string, unknown>) => Promise<import('puppeteer-core').Browser>;
  try {
    const mod = await import('puppeteer-core');
    launch = (opts) => mod.default.launch(opts as Parameters<typeof mod.default.launch>[0]);
  } catch {
    return {
      error: 'puppeteer-core is not installed. Run: npm install puppeteer-core',
    };
  }

  let browser: import('puppeteer-core').Browser | undefined;
  try {
    // Use system Chromium (installed in Docker) or fall back to default path
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

    browser = await launch({
      headless: true,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    await page.goto(args.url, {
      waitUntil: 'networkidle2',
      timeout: SCREENSHOT_TIMEOUT_MS,
    });

    if (args.selector) {
      // Wait for and capture a specific element
      const element = await page.waitForSelector(args.selector, { timeout: 10_000 });
      if (element) {
        await element.screenshot({ path: filepath });
      } else {
        return { error: `Selector "${args.selector}" not found on the page.` };
      }
    } else {
      await page.screenshot({
        path: filepath,
        fullPage: args.fullPage ?? false,
      });
    }

    logger.info({ url: args.url, filepath }, 'Screenshot captured');

    return {
      filepath,
      filename,
      url: args.url,
      message: `Screenshot saved: ${filename}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, url: args.url }, 'Screenshot failed');
    return { error: `Screenshot failed: ${msg}` };
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}
