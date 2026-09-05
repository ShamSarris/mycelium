import _Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { ToolDeclaration } from '../transport/transport.js';

// ajv ships CommonJS, so under NodeNext the default export is the module object
// rather than the constructor. The same cast the contracts package makes.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;

/**
 * Host-side tool-argument validation (archive T17).
 *
 * `strict: true` on the declaration asks the provider for schema-valid
 * arguments; this checks that it got them. The two are not the same guarantee,
 * because the model producing those arguments is assumed prompt-injectable. A
 * call that fails is reported back so the model can correct it, and never
 * executed as guessed.
 *
 * The same schema object is sent to the provider and compiled here, so the
 * declaration and the check cannot drift apart.
 */

export type ArgCheck =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; message: string };

export function buildArgChecker(
  tools: ToolDeclaration[],
): (name: string, input: unknown) => ArgCheck {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const compiled = new Map<string, ValidateFunction>();

  for (const tool of tools) {
    compiled.set(tool.name, ajv.compile(tool.inputSchema));
  }

  return (name, input) => {
    const validate = compiled.get(name);
    if (validate === undefined) {
      return { ok: false, message: `no such tool: ${name}` };
    }

    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { ok: false, message: `${name} takes an object of arguments` };
    }

    // Cloned so a validator that fills defaults cannot reach back into the
    // caller's object, and so a rejected call leaves nothing behind.
    const candidate = structuredClone(input) as Record<string, unknown>;

    if (!validate(candidate)) {
      return { ok: false, message: `${name}: ${describe(validate.errors)}` };
    }

    return { ok: true, args: candidate };
  };
}

/**
 * The model has to be able to act on this, so it names the field rather than
 * quoting an instance path it has no way to interpret.
 */
function describe(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => {
      const field =
        typeof error.params?.missingProperty === 'string'
          ? error.params.missingProperty
          : typeof error.params?.additionalProperty === 'string'
            ? error.params.additionalProperty
            : error.instancePath.replace(/^\//, '').replace(/\//g, '.');

      return field === '' ? (error.message ?? 'is invalid') : `${field} ${error.message ?? 'is invalid'}`;
    })
    .join('; ');
}
