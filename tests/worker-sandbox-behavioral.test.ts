/**
 * SA1 Behavioral Sanity Tests
 *
 * These tests validate the Worker sandbox from a USER's perspective —
 * real tool patterns that departments actually create, not just unit edge cases.
 * Covers: finance, operations, HR, sales, IT, logistics, general-purpose.
 */

import { describe, it, expect } from 'vitest';
import { executeInWorker } from '../src/forge/worker-sandbox.js';

describe('worker-sandbox behavioral', () => {
  // ──────────────────────────────────────────────
  // Real-world tool patterns across departments
  // ──────────────────────────────────────────────

  describe('general-purpose tools', () => {
    it('JSON transformation tool — parse, reshape, return', async () => {
      const code = `
        const data = JSON.parse(args.json_input);
        const keys = Object.keys(data);
        const summary = keys.map(k => k + ': ' + typeof data[k]);
        return { field_count: keys.length, fields: summary };
      `;
      const result = await executeInWorker(code, {
        json_input: '{"name":"Alice","age":30,"active":true}',
      });
      expect(result).toEqual({
        field_count: 3,
        fields: ['name: string', 'age: number', 'active: boolean'],
      });
    });

    it('CSV row processor — split, filter, aggregate', async () => {
      const code = `
        const rows = args.csv.split('\\n').map(r => r.split(','));
        const header = rows[0];
        const data = rows.slice(1);
        const totals = {};
        for (const row of data) {
          const category = row[0];
          const amount = parseFloat(row[1]) || 0;
          totals[category] = (totals[category] || 0) + amount;
        }
        return { categories: Object.keys(totals).length, totals };
      `;
      const result = await executeInWorker(code, {
        csv: 'category,amount\nFood,25.50\nTransport,12.00\nFood,30.00\nTransport,8.50',
      });
      expect(result).toEqual({
        categories: 2,
        totals: { Food: 55.5, Transport: 20.5 },
      });
    });

    it('date/time calculation tool — no external deps needed', async () => {
      const code = `
        const start = new Date(args.start_date);
        const end = new Date(args.end_date);
        const diffMs = end.getTime() - start.getTime();
        const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        const weeks = Math.floor(days / 7);
        return { days, weeks, business_days: days - (weeks * 2) };
      `;
      const result = await executeInWorker(code, {
        start_date: '2026-01-01',
        end_date: '2026-01-31',
      });
      expect(result).toEqual({ days: 30, weeks: 4, business_days: 22 });
    });

    it('text analysis tool — word count, character stats', async () => {
      const code = `
        const text = args.text;
        const words = text.trim().split(/\\s+/).filter(w => w.length > 0);
        const chars = text.length;
        const unique = new Set(words.map(w => w.toLowerCase()));
        return { word_count: words.length, char_count: chars, unique_words: unique.size };
      `;
      const result = await executeInWorker(code, {
        text: 'The quick brown fox jumps over the lazy dog',
      });
      expect(result).toEqual({ word_count: 9, char_count: 43, unique_words: 8 });
    });
  });

  describe('finance department tools', () => {
    it('compound interest calculator', async () => {
      const code = `
        const p = args.principal;
        const r = args.rate / 100;
        const n = args.compounds_per_year;
        const t = args.years;
        const amount = p * Math.pow(1 + r / n, n * t);
        const interest = amount - p;
        return {
          final_amount: Math.round(amount * 100) / 100,
          interest_earned: Math.round(interest * 100) / 100,
        };
      `;
      const result = await executeInWorker(code, {
        principal: 10000,
        rate: 5,
        compounds_per_year: 12,
        years: 10,
      });
      expect(result.final_amount).toBeCloseTo(16470.09, 0);
      expect(result.interest_earned).toBeCloseTo(6470.09, 0);
    });

    it('invoice line item aggregator', async () => {
      const code = `
        const items = args.items;
        let subtotal = 0;
        const lines = [];
        for (const item of items) {
          const lineTotal = item.qty * item.unit_price;
          subtotal += lineTotal;
          lines.push({ description: item.description, total: lineTotal });
        }
        const tax = subtotal * (args.tax_rate / 100);
        return { lines, subtotal, tax: Math.round(tax * 100) / 100, grand_total: Math.round((subtotal + tax) * 100) / 100 };
      `;
      const result = await executeInWorker(code, {
        items: [
          { description: 'Widget A', qty: 10, unit_price: 25.00 },
          { description: 'Widget B', qty: 5, unit_price: 42.50 },
        ],
        tax_rate: 16,
      });
      expect(result.subtotal).toBe(462.5);
      expect(result.tax).toBe(74);
      expect(result.grand_total).toBe(536.5);
    });
  });

  describe('HR / people ops tools', () => {
    it('PTO balance calculator', async () => {
      const code = `
        const accrual_per_month = args.annual_days / 12;
        const months_worked = args.months_employed;
        const accrued = accrual_per_month * months_worked;
        const balance = accrued - args.days_taken;
        return {
          accrued: Math.round(accrued * 10) / 10,
          taken: args.days_taken,
          balance: Math.round(balance * 10) / 10,
          status: balance < 0 ? 'deficit' : balance < 2 ? 'low' : 'ok',
        };
      `;
      const result = await executeInWorker(code, {
        annual_days: 15,
        months_employed: 8,
        days_taken: 7,
      });
      expect(result.balance).toBe(3);
      expect(result.status).toBe('ok');
    });
  });

  describe('logistics / supply chain tools', () => {
    it('shipping cost estimator with weight brackets', async () => {
      const code = `
        const weight = args.weight_kg;
        const distance = args.distance_km;
        let rate;
        if (weight <= 1) rate = 5;
        else if (weight <= 5) rate = 3.5;
        else if (weight <= 20) rate = 2.8;
        else rate = 2.2;
        const base = weight * rate;
        const distanceSurcharge = distance > 500 ? (distance - 500) * 0.01 : 0;
        const total = base + distanceSurcharge;
        return {
          base_cost: Math.round(base * 100) / 100,
          surcharge: Math.round(distanceSurcharge * 100) / 100,
          total: Math.round(total * 100) / 100,
          bracket: weight <= 1 ? 'light' : weight <= 5 ? 'medium' : weight <= 20 ? 'standard' : 'heavy',
        };
      `;
      const result = await executeInWorker(code, {
        weight_kg: 8,
        distance_km: 750,
      });
      expect(result.bracket).toBe('standard');
      expect(result.base_cost).toBe(22.4);
      expect(result.surcharge).toBe(2.5);
      expect(result.total).toBe(24.9);
    });
  });

  // ──────────────────────────────────────────────
  // Edge cases that real tools will hit
  // ──────────────────────────────────────────────

  describe('return value edge cases', () => {
    it('code that returns undefined', async () => {
      const result = await executeInWorker('return undefined;', {});
      expect(result).toEqual({ result: undefined });
    });

    it('code with no explicit return', async () => {
      const result = await executeInWorker('const x = 1 + 1;', {});
      expect(result).toEqual({ result: undefined });
    });

    it('code that returns an array', async () => {
      const result = await executeInWorker('return [1, 2, 3];', {});
      // Arrays are objects, should pass through
      expect(result).toEqual([1, 2, 3]);
    });

    it('code that returns deeply nested object', async () => {
      const code = `
        return {
          level1: {
            level2: {
              level3: { value: 'deep', items: [1, 2, { nested: true }] }
            }
          }
        };
      `;
      const result = await executeInWorker(code, {});
      expect((result as any).level1.level2.level3.value).toBe('deep');
    });

    it('code that returns empty object', async () => {
      const result = await executeInWorker('return {};', {});
      expect(result).toEqual({});
    });

    it('code that returns boolean false', async () => {
      const result = await executeInWorker('return false;', {});
      expect(result).toEqual({ result: false });
    });

    it('code that returns zero', async () => {
      const result = await executeInWorker('return 0;', {});
      expect(result).toEqual({ result: 0 });
    });

    it('code that returns empty string', async () => {
      const result = await executeInWorker('return "";', {});
      expect(result).toEqual({ result: '' });
    });
  });

  describe('user code patterns that should work', () => {
    it('console.log does not crash the Worker', async () => {
      // Users will inevitably write console.log — it must not crash
      const result = await executeInWorker(
        'console.log("debug output"); return { ok: true };',
        {},
      );
      expect(result).toEqual({ ok: true });
    });

    it('try/catch inside user code works', async () => {
      const code = `
        try {
          JSON.parse('invalid json{{{');
        } catch (e) {
          return { caught: true, message: e.message };
        }
      `;
      const result = await executeInWorker(code, {});
      expect(result.caught).toBe(true);
      expect(result.message).toBeDefined();
    });

    it('user code can use Map and Set', async () => {
      const code = `
        const m = new Map();
        m.set('a', 1);
        m.set('b', 2);
        const s = new Set([1, 2, 2, 3]);
        return { map_size: m.size, set_size: s.size };
      `;
      const result = await executeInWorker(code, {});
      expect(result).toEqual({ map_size: 2, set_size: 3 });
    });

    it('user code can use regex', async () => {
      const code = `
        const emails = args.text.match(/[\\w.+-]+@[\\w-]+\\.[\\w.]+/g) || [];
        return { found: emails.length, emails };
      `;
      const result = await executeInWorker(code, {
        text: 'Contact us at info@company.com or support@company.com for details',
      });
      expect(result.found).toBe(2);
    });

    it('user code can use Array methods (map, filter, reduce)', async () => {
      const code = `
        const nums = args.numbers;
        const evens = nums.filter(n => n % 2 === 0);
        const sum = nums.reduce((a, b) => a + b, 0);
        const doubled = nums.map(n => n * 2);
        return { evens, sum, doubled };
      `;
      const result = await executeInWorker(code, { numbers: [1, 2, 3, 4, 5] });
      expect(result).toEqual({
        evens: [2, 4],
        sum: 15,
        doubled: [2, 4, 6, 8, 10],
      });
    });

    it('user code can use destructuring and spread', async () => {
      const code = `
        const { name, ...rest } = args;
        return { name, extra_keys: Object.keys(rest) };
      `;
      const result = await executeInWorker(code, { name: 'test', a: 1, b: 2 });
      expect(result).toEqual({ name: 'test', extra_keys: ['a', 'b'] });
    });

    it('user code can use template literals', async () => {
      const code = 'return { greeting: `Hello ${args.name}, you have ${args.count} items` };';
      const result = await executeInWorker(code, { name: 'Maria', count: 5 });
      expect(result).toEqual({ greeting: 'Hello Maria, you have 5 items' });
    });
  });

  describe('error quality — messages must be actionable', () => {
    it('timeout error contains both EN and ES with _timeout hint', async () => {
      const result = await executeInWorker(
        'while(true) {}',
        {},
        { baseTimeoutMs: 300, maxTimeoutMs: 1000 },
      );
      const err = result.error as string;
      // EN section
      expect(err).toContain('[EN]');
      expect(err).toContain('timed out');
      expect(err).toContain('_timeout');
      // ES section
      expect(err).toContain('[ES]');
      expect(err).toContain('agoto el tiempo');
      expect(err).toContain('_timeout');
      expect(err).toContain('reintentar');
    }, 5000);

    it('OOM error contains both EN and ES with _memory_mb hint', async () => {
      const result = await executeInWorker(
        'const a = []; for(let i=0;i<1000;i++) a.push(new Array(1000000).fill("x")); return {ok:true};',
        {},
        { baseTimeoutMs: 10000, maxTimeoutMs: 15000 },
      );
      const err = result.error as string;
      // EN section
      expect(err).toContain('[EN]');
      expect(err).toContain('out of memory');
      expect(err).toContain('_memory_mb');
      expect(err).toContain('smaller batches');
      // ES section
      expect(err).toContain('[ES]');
      expect(err).toContain('sin memoria');
      expect(err).toContain('_memory_mb');
      expect(err).toContain('lotes');
    }, 20000);

    it('SSRF error contains both EN and ES', async () => {
      const result = await executeInWorker(
        'await fetch("http://127.0.0.1:8080/admin"); return {ok:true};',
        {},
        { baseTimeoutMs: 5000, maxTimeoutMs: 10000 },
      );
      const err = result.error as string;
      expect(err).toContain('[EN]');
      expect(err).toContain('blocked');
      expect(err).toContain('[ES]');
      expect(err).toContain('bloqueado');
    }, 10000);

    it('generic code error includes bilingual message with actual error', async () => {
      const result = await executeInWorker(
        'const obj = null; return obj.property;',
        {},
      );
      const err = result.error as string;
      expect(err).toContain('Cannot read properties of null');
      expect(err).toContain('[EN]');
      expect(err).toContain('[ES]');
      expect(err).toContain('fallo');
    });
  });

  describe('structured clone boundary', () => {
    it('handles args with Date-like strings (no Date objects in JSON)', async () => {
      // AI sends args as JSON — Date objects become strings
      const result = await executeInWorker(
        'return { date: new Date(args.date_str).toISOString().split("T")[0] };',
        { date_str: '2026-03-15T10:30:00Z' },
      );
      expect(result).toEqual({ date: '2026-03-15' });
    });

    it('handles large but reasonable args (10KB payload)', async () => {
      const largeArray = Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        name: `Item ${i}`,
        value: Math.random(),
      }));
      const result = await executeInWorker(
        'return { count: args.items.length, first: args.items[0].name, last: args.items[args.items.length - 1].name };',
        { items: largeArray },
      );
      expect(result).toEqual({ count: 1000, first: 'Item 0', last: 'Item 999' });
    });

    it('handles unicode / multilingual content in args and returns', async () => {
      const result = await executeInWorker(
        'return { greeting: args.greeting + " " + args.name, lang: "mixed" };',
        { greeting: 'Hola, bienvenido', name: '太郎' },
      );
      expect(result).toEqual({ greeting: 'Hola, bienvenido 太郎', lang: 'mixed' });
    });

    it('handles special characters in strings', async () => {
      const result = await executeInWorker(
        'return { processed: args.input.replace(/[<>"]/g, "") };',
        { input: '<script>alert("xss")</script>' },
      );
      expect(result).toEqual({ processed: 'scriptalert(xss)/script' });
    });
  });

  describe('conversational retry flow simulation', () => {
    it('first call times out, retry with _timeout succeeds', async () => {
      // Simulates: user creates tool, it times out, user says "try with 5 seconds"
      const slowCode = `
        heartbeat();
        await new Promise(r => setTimeout(r, 400));
        return { data: 'completed' };
      `;

      // First attempt — tight timeout, fails
      const attempt1 = await executeInWorker(slowCode, {}, { baseTimeoutMs: 200, maxTimeoutMs: 300 });
      expect(attempt1.error).toContain('timed out');

      // Retry with _timeout override — succeeds
      const attempt2 = await executeInWorker(slowCode, { _timeout: 5 }, { baseTimeoutMs: 200, maxTimeoutMs: 300 });
      expect(attempt2).toEqual({ data: 'completed' });
    }, 10000);

    it('first call OOMs, retry with _memory_mb succeeds', async () => {
      // Allocate many large arrays to reliably exceed tight memory limit
      const memoryCode = `
        const arrays = [];
        for (let i = 0; i < 50; i++) {
          arrays.push(new Array(500_000).fill('data-' + i));
        }
        return { total: arrays.length };
      `;

      // First attempt — tight memory (8MB), should fail
      const attempt1 = await executeInWorker(memoryCode, {}, { memoryMb: 8, baseTimeoutMs: 10000, maxTimeoutMs: 15000 });
      expect(attempt1.error).toContain('memory');

      // Retry with more memory — succeeds
      const attempt2 = await executeInWorker(memoryCode, { _memory_mb: 256 }, { baseTimeoutMs: 10000, maxTimeoutMs: 15000 });
      expect(attempt2).toEqual({ total: 50 });
    }, 30000);
  });
});
