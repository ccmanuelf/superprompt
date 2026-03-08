import { describe, it, expect } from 'vitest';
import { scanToolCode } from '../src/forge/safety-scanner.js';

describe('scanToolCode', () => {
  it('allows safe code', () => {
    const code = `
      const response = await fetch('https://api.example.com/data');
      const data = await response.json();
      return { result: data.value };
    `;
    const result = scanToolCode(code);
    expect(result.safe).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('blocks process.exit', () => {
    const result = scanToolCode('process.exit(1)');
    expect(result.safe).toBe(false);
    expect(result.issues).toContain('process.exit() is not allowed');
  });

  it('blocks eval', () => {
    const result = scanToolCode('const x = eval("1+1")');
    expect(result.safe).toBe(false);
    expect(result.issues).toContain('eval() is not allowed');
  });

  it('blocks require child_process', () => {
    const result = scanToolCode("const cp = require('child_process')");
    expect(result.safe).toBe(false);
    expect(result.issues).toContain('child_process is not allowed');
  });

  it('blocks exec', () => {
    const result = scanToolCode('exec("rm -rf /")');
    expect(result.safe).toBe(false);
    expect(result.issues).toContain('exec() is not allowed');
  });

  it('blocks spawn', () => {
    const result = scanToolCode('spawn("ls")');
    expect(result.safe).toBe(false);
    expect(result.issues).toContain('spawn() is not allowed');
  });

  it('blocks new Function', () => {
    const result = scanToolCode('const fn = new Function("return 1")');
    expect(result.safe).toBe(false);
    expect(result.issues).toContain('new Function() is not allowed');
  });

  it('blocks writeFile', () => {
    const result = scanToolCode('writeFileSync("/etc/passwd", "hacked")');
    expect(result.safe).toBe(false);
    expect(result.issues).toContain('file writes are not allowed');
  });

  it('blocks process.env', () => {
    const result = scanToolCode('const key = process.env.SECRET');
    expect(result.safe).toBe(false);
    expect(result.issues).toContain('process.env access is not allowed');
  });

  it('blocks dynamic node: imports', () => {
    const result = scanToolCode("await import('node:fs')");
    expect(result.safe).toBe(false);
    expect(result.issues).toContain('dynamic node: imports are not allowed');
  });

  it('blocks fetch to localhost', () => {
    const result = scanToolCode("fetch('http://localhost:8080/secret')");
    expect(result.safe).toBe(false);
    expect(result.issues).toContain('fetch() to internal/private IPs is not allowed');
  });

  it('blocks fetch to private IPs', () => {
    const result = scanToolCode("fetch('http://192.168.1.1/admin')");
    expect(result.safe).toBe(false);
  });

  it('reports multiple issues', () => {
    const code = 'eval("x"); process.exit(0); exec("ls")';
    const result = scanToolCode(code);
    expect(result.safe).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
  });

  it('allows JSON and string operations', () => {
    const code = `
      const parsed = JSON.parse(args.data);
      const result = parsed.map(item => item.name.toUpperCase());
      return { items: result, count: result.length };
    `;
    const result = scanToolCode(code);
    expect(result.safe).toBe(true);
  });
});
