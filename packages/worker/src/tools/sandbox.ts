import { BrokerRejection, type SandboxRunParams } from '../broker.js';
import type { Deps } from '../deps.js';
import type { ToolDeclaration } from '../transport/transport.js';
import type { ToolOutcome } from './registry.js';

/**
 * All code execution goes through here (archive T2): the agent never touches
 * the Docker socket, and the supervisor launches a sibling gVisor container
 * with the checkout mounted at /workspace.
 *
 * Almost nothing is validated on this side, deliberately. The image allowlist,
 * the credential-shaped-env refusal, the per-plan cap and the resource ceilings
 * all live in the broker, because an allowlist the agent could edit would not
 * be one. The two checks here exist only to keep a pointless round trip and a
 * confusing error out of the transcript.
 */

/** Set by the supervisor for a networked sandbox; an agent that sets them is refused. */
const RESERVED_ENV = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY']);

export function declaration(): ToolDeclaration {
  return {
    name: 'sandbox',
    description:
      'Run a command in an isolated container with the plan checkout mounted at /workspace. ' +
      'This is how you build, test, and run anything. The container has no route to the ' +
      'internet except the plan allowlist, and it holds no credentials.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['image', 'cmd'],
      properties: {
        image: { type: 'string', description: 'A container image from the node allowlist.' },
        cmd: {
          type: 'array',
          items: { type: 'string' },
          description: 'Argv, at least one element. Not a shell string; use ["sh", "-lc", "..."] if you want a shell.',
        },
        env: {
          // A closed array of pairs, not an open map: the provider rejects an
          // object schema whose additionalProperties is not false.
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'value'],
            properties: {
              name: { type: 'string' },
              value: { type: 'string' },
            },
          },
          description:
            'Extra environment, as {name, value} pairs. Never credentials; the container is not trusted with them.',
        },
        network: {
          type: 'boolean',
          description: 'Attach the plan network, reaching only the plan allowlist through a proxy.',
        },
        timeout_sec: { type: 'integer', description: 'Wall-clock kill after this many seconds; must be positive.' },
      },
    },
  };
}

interface Args {
  image: string;
  cmd: string[];
  env?: Array<{ name: string; value: string }>;
  network?: boolean;
  timeout_sec?: number;
}

export async function run(deps: Deps, raw: Record<string, unknown>): Promise<ToolOutcome> {
  const args = raw as unknown as Args;

  // The schema can no longer carry these bounds - `strict: true` rejects
  // `minItems`/`minimum` - so they are checked here, where a bad call becomes a
  // tool result the model can correct rather than a confusing broker error.
  if (args.cmd.length === 0) {
    return error('cmd needs at least one element; it is argv, not a shell string');
  }
  if (args.timeout_sec !== undefined && args.timeout_sec < 1) {
    return error(`timeout_sec must be a positive number of seconds, got ${args.timeout_sec}`);
  }

  const env: Record<string, string> = {};
  for (const { name, value } of args.env ?? []) env[name] = value;

  const offending = Object.keys(env).find((key) => RESERVED_ENV.has(key));
  if (offending !== undefined) {
    return error(`${offending} is set by the supervisor for a networked sandbox, not by you`);
  }

  const params: SandboxRunParams = {
    image: args.image,
    cmd: args.cmd,
    ...(Object.keys(env).length === 0 ? {} : { env }),
    ...(args.network === undefined ? {} : { network: args.network }),
    ...(args.timeout_sec === undefined ? {} : { limits: { timeout_sec: args.timeout_sec } }),
  };

  try {
    const result = await deps.broker.sandboxRun(params);
    return { kind: 'result', content: render(result), isError: false };
  } catch (caught) {
    if (caught instanceof BrokerRejection) {
      return error(`${caught.code}: ${caught.message}`);
    }
    throw caught;
  }
}

function render(result: {
  exit_code: number;
  timed_out: boolean;
  stdout: { preview: string; bytes: number; truncated: boolean };
  stderr: { preview: string; bytes: number; truncated: boolean };
}): string {
  const lines = [
    result.timed_out
      ? 'The command timed out and was killed.'
      : `The command finished with exit code ${result.exit_code}.`,
  ];

  for (const [name, stream] of [
    ['stdout', result.stdout],
    ['stderr', result.stderr],
  ] as const) {
    if (stream.bytes === 0) continue;
    lines.push('', `--- ${name} ---`, stream.preview);
    if (stream.truncated) {
      // Said explicitly. A model that thinks it read all of the output will
      // draw conclusions from the half it got.
      lines.push(`(${name} was ${stream.bytes} bytes and has been truncated)`);
    }
  }

  return lines.join('\n');
}

function error(message: string): ToolOutcome {
  return { kind: 'result', content: message, isError: true };
}
