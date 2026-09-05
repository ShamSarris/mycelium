import { describe, expect, it } from 'vitest';
import { buildArgChecker } from '../../src/domain/args.js';
import type { ToolDeclaration } from '../../src/transport/transport.js';

/**
 * `strict: true` on the tool declaration constrains the model; this constrains
 * the call. They are not the same guarantee — the threat model here is a model
 * under injection, and a call that fails validation is reported back so it can
 * be corrected, never executed as guessed (archive T17).
 */

const TOOLS: ToolDeclaration[] = [
  {
    name: 'read_file',
    description: 'Read a file from the plan checkout.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string' },
        max_bytes: { type: 'integer', minimum: 1 },
      },
    },
  },
];

const check = buildArgChecker(TOOLS);

describe('buildArgChecker', () => {
  it('passes a valid call through', () => {
    const result = check('read_file', { path: 'src/index.ts' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.args).toEqual({ path: 'src/index.ts' });
  });

  it('rejects a missing required field and names it', () => {
    const result = check('read_file', { max_bytes: 10 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('path');
  });

  it('rejects a wrong type and names the field', () => {
    const result = check('read_file', { path: 42 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('path');
  });

  it('rejects an extra property rather than dropping it', () => {
    const result = check('read_file', { path: 'a.ts', sudo: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('sudo');
  });

  it('rejects an unknown tool name', () => {
    const result = check('rm_rf', { path: '/' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('rm_rf');
  });

  it('rejects input that is not an object at all', () => {
    expect(check('read_file', 'src/index.ts').ok).toBe(false);
    expect(check('read_file', null).ok).toBe(false);
    expect(check('read_file', [1, 2]).ok).toBe(false);
  });

  it('does not mutate the input it was handed', () => {
    const input = { path: 'src/index.ts' };
    check('read_file', input);

    expect(input).toEqual({ path: 'src/index.ts' });
  });
});
