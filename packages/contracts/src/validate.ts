import _Ajv2020 from 'ajv/dist/2020.js';
import _addFormats from 'ajv-formats';
import type { ErrorObject, ValidateFunction } from 'ajv';

import planSchema from '../schemas/plan.schema.json' with { type: 'json' };
import eventSchema from '../schemas/event.schema.json' with { type: 'json' };
import type { Plan } from './generated/plan.js';
import type { EventEnvelope } from './generated/event.js';
import type { ValidationIssue, ValidationResult } from './errors.js';
import { checkTaskGraph } from './graph.js';

// ajv ships CommonJS, so under NodeNext the default export is the module object
// rather than the constructor. These casts fix the types without changing runtime.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

// useDefaults fills documented defaults onto the returned value, so every
// consumer sees the same fully-populated plan. Input is cloned first.
const ajv = new Ajv2020({ allErrors: true, useDefaults: true, strict: false });
addFormats(ajv);

const compiledPlan: ValidateFunction = ajv.compile(planSchema);
const compiledEvent: ValidateFunction = ajv.compile(eventSchema);

function toIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((e) => ({
    kind: 'schema' as const,
    code: e.keyword,
    path: e.instancePath === '' ? '/' : e.instancePath,
    message: e.message ?? 'is invalid',
  }));
}

/**
 * Validates a plan against `plan.schema.json`, then applies the DAG checks JSON
 * Schema cannot express. Semantic checks run only once the shape is trusted, so
 * a schema failure short-circuits.
 */
export function validatePlan(input: unknown): ValidationResult<Plan> {
  const candidate = structuredClone(input);

  if (!compiledPlan(candidate)) {
    return { ok: false, issues: toIssues(compiledPlan.errors) };
  }

  const plan = candidate as Plan;
  const issues = checkTaskGraph(plan.tasks);
  if (issues.length > 0) return { ok: false, issues };

  return { ok: true, value: plan };
}

/** Validates one event envelope. The payload is not inspected in v1. */
export function validateEvent(input: unknown): ValidationResult<EventEnvelope> {
  const candidate = structuredClone(input);

  if (!compiledEvent(candidate)) {
    return { ok: false, issues: toIssues(compiledEvent.errors) };
  }

  return { ok: true, value: candidate as EventEnvelope };
}
