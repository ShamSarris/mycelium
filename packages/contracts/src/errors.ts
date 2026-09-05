/** A single reason a document was rejected. */
export interface ValidationIssue {
  /** `schema` comes from ajv; `semantic` comes from checks JSON Schema cannot express. */
  kind: 'schema' | 'semantic';
  /** Stable machine-readable reason, e.g. `dependency_cycle`. */
  code: string;
  /** JSON Pointer into the submitted document, e.g. `/tasks/2/depends_on/0`. */
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };
