import { describe, expect, it } from 'vitest';
import { parseHostMetrics } from '../src/domain/telemetry.js';

/**
 * A supervisor is a semi-trusted peer that writes into a jsonb column the
 * dashboard renders. This is the only thing standing between it and arbitrary
 * content on the operator's screen, so it is tested as a pure function with no
 * database in the way.
 */
describe('parseHostMetrics', () => {
  const full = {
    uptime_sec: 86_400,
    cpu_count: 4,
    load_1: 1.5,
    load_5: 1.2,
    load_15: 0.9,
    cpu_saturation: 0.375,
    mem_total_mb: 8192,
    mem_available_mb: 5120,
    mem_used_pct: 37.5,
    disk_total_mb: 40_960,
    disk_free_mb: 22_000,
    disk_used_pct: 46.3,
    environments: 1,
    environment_capacity: 2,
    sandboxes: 0,
    version: '0.1.0',
  };

  it('passes a complete, well-formed report through unchanged', () => {
    expect(parseHostMetrics(full)).toEqual(full);
  });

  describe('returns null rather than an empty object', () => {
    // An un-upgraded supervisor posts `{}`. Null is what lets the UPDATE's
    // coalesce leave the stored column alone instead of overwriting real
    // telemetry with nothing.
    it.each([
      ['an empty object', {}],
      ['null', null],
      ['undefined', undefined],
      ['a string', 'metrics'],
      ['a number', 7],
      ['an array', [1, 2, 3]],
      ['an object of only unknown keys', { pid: 900, hostname: 'worker-1' }],
      ['an object of only invalid values', { cpu_count: 'four', load_1: 'high' }],
    ])('%s', (_label, input) => {
      expect(parseHostMetrics(input)).toBeNull();
    });
  });

  it('drops unknown keys rather than storing what a supervisor invents', () => {
    const parsed = parseHostMetrics({
      cpu_count: 4,
      hostname: 'worker-1',
      secret_token: 'sk-live-nope',
      '<script>': 'alert(1)',
    });
    expect(parsed).toEqual({ cpu_count: 4 });
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a numeric string', '7'],
    ['a boolean', true],
    ['an object', { value: 7 }],
    ['an array', [7]],
    ['a negative count', -1],
  ])('drops a numeric field that is %s', (_label, value) => {
    expect(parseHostMetrics({ cpu_count: value, load_1: 1 })).toEqual({ load_1: 1 });
  });

  it('clamps a percentage to 0..100 rather than dropping it', () => {
    expect(parseHostMetrics({ mem_used_pct: 137, disk_used_pct: 100.4 })).toEqual({
      mem_used_pct: 100,
      disk_used_pct: 100,
    });
  });

  it('keeps a cpu_saturation above 1, which is a real and important reading', () => {
    // Eight runnable processes on four cores is exactly what the operator needs
    // to see; clamping it to 1 would hide the overload.
    expect(parseHostMetrics({ cpu_saturation: 2.4 })).toEqual({ cpu_saturation: 2.4 });
  });

  it('accepts an explicit null for the disk fields, which statfs may not answer', () => {
    expect(parseHostMetrics({ disk_total_mb: null, disk_free_mb: null, disk_used_pct: null }))
      .toBeNull();
  });

  it('keeps the rest when only the disk fields are missing', () => {
    expect(parseHostMetrics({ cpu_count: 2, disk_free_mb: null })).toEqual({ cpu_count: 2 });
  });

  it('truncates a long version rather than letting it into the servers table', () => {
    const parsed = parseHostMetrics({ version: 'v'.repeat(200) });
    expect(parsed?.version).toHaveLength(32);
  });

  it('drops a version that is not a string', () => {
    expect(parseHostMetrics({ version: 12, cpu_count: 1 })).toEqual({ cpu_count: 1 });
  });

  it('drops an empty version, which says less than no version at all', () => {
    expect(parseHostMetrics({ version: '   ', cpu_count: 1 })).toEqual({ cpu_count: 1 });
  });

  it('never throws, whatever it is handed', () => {
    const hostile: Record<string, unknown> = { cpu_count: 1 };
    hostile.self = hostile;
    expect(() => parseHostMetrics(hostile)).not.toThrow();
    expect(parseHostMetrics(hostile)).toEqual({ cpu_count: 1 });
  });
});
