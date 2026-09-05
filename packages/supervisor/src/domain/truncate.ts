/**
 * Sandbox output is bounded before it reaches the agent, and therefore before
 * it reaches a model context. The caps are configuration; this is the rule.
 */
export interface OutputCaps {
  headBytes: number;
  tailBytes: number;
}

export interface BoundedOutput {
  /** Head, an omission marker, and tail. The whole buffer when it fits. */
  preview: string;
  /** Bytes observed, which is what the agent needs to know it lost something. */
  bytes: number;
  truncated: boolean;
}

const encoder = new TextDecoder('utf8');

export function headTail(buffer: Buffer, caps: OutputCaps): BoundedOutput {
  const bytes = buffer.length;
  const budget = caps.headBytes + caps.tailBytes;

  // At or under the budget the two slices would overlap, so return the buffer
  // whole rather than stitching a preview that repeats bytes.
  if (bytes <= budget) {
    return { preview: encoder.decode(buffer), bytes, truncated: false };
  }

  const head = encoder.decode(buffer.subarray(0, caps.headBytes));
  const tail = caps.tailBytes === 0 ? '' : encoder.decode(buffer.subarray(bytes - caps.tailBytes));
  const omitted = bytes - budget;

  return {
    preview: `${head}\n...[${omitted} bytes omitted]...\n${tail}`,
    bytes,
    truncated: true,
  };
}
