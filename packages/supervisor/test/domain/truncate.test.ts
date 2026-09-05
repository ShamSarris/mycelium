import { describe, expect, it } from 'vitest';
import { headTail } from '../../src/domain/truncate.js';

const caps = { headBytes: 8, tailBytes: 4 };

describe('headTail - short output is returned whole', () => {
  it('returns an empty preview for empty output', () => {
    const bounded = headTail(Buffer.from(''), caps);
    expect(bounded).toEqual({ preview: '', bytes: 0, truncated: false });
  });

  it('returns the whole buffer when it is shorter than the two caps', () => {
    const bounded = headTail(Buffer.from('abc'), caps);
    expect(bounded.preview).toBe('abc');
    expect(bounded.bytes).toBe(3);
    expect(bounded.truncated).toBe(false);
  });

  // The bug this guards: head and tail slices overlapping and repeating bytes.
  it('does not repeat bytes when the buffer is shorter than head plus tail', () => {
    const bounded = headTail(Buffer.from('abcdefghij'), caps);
    expect(bounded.preview).toBe('abcdefghij');
    expect(bounded.truncated).toBe(false);
  });

  it('returns the whole buffer at exactly head plus tail', () => {
    const bounded = headTail(Buffer.from('abcdefghijkl'), caps);
    expect(bounded.preview).toBe('abcdefghijkl');
    expect(bounded.bytes).toBe(12);
    expect(bounded.truncated).toBe(false);
  });
});

describe('headTail - long output is bounded', () => {
  it('keeps the head and the tail and says how much it dropped', () => {
    const bounded = headTail(Buffer.from('abcdefghijklmnopqrstuvwxyz'), caps);
    expect(bounded.preview.startsWith('abcdefgh')).toBe(true);
    expect(bounded.preview.endsWith('wxyz')).toBe(true);
    expect(bounded.preview).toContain('14 bytes omitted');
    expect(bounded.bytes).toBe(26);
    expect(bounded.truncated).toBe(true);
  });

  it('reports the observed size, not the preview size', () => {
    const bounded = headTail(Buffer.alloc(5000, 0x61), caps);
    expect(bounded.bytes).toBe(5000);
    expect(bounded.preview.length).toBeLessThan(200);
  });

  it('keeps the whole buffer when a cap is zero on one side only', () => {
    const bounded = headTail(Buffer.from('abcdefghij'), { headBytes: 4, tailBytes: 0 });
    expect(bounded.preview.startsWith('abcd')).toBe(true);
    expect(bounded.preview).toContain('6 bytes omitted');
    expect(bounded.truncated).toBe(true);
  });
});

describe('headTail - multibyte output', () => {
  it('slices on byte boundaries and still produces a decodable preview', () => {
    // Four bytes per emoji, so an 8-byte head lands mid-character at the tail cut.
    const emoji = Buffer.from('🍄'.repeat(20), 'utf8');
    const bounded = headTail(emoji, caps);

    expect(bounded.bytes).toBe(80);
    expect(bounded.truncated).toBe(true);
    expect(bounded.preview.startsWith('🍄🍄')).toBe(true);
    expect(typeof bounded.preview).toBe('string');
  });

  it('counts bytes rather than characters when deciding to truncate', () => {
    // Three characters, nine bytes: over the twelve-byte budget it is not.
    const bounded = headTail(Buffer.from('日本語', 'utf8'), caps);
    expect(bounded.bytes).toBe(9);
    expect(bounded.truncated).toBe(false);
    expect(bounded.preview).toBe('日本語');
  });
});
