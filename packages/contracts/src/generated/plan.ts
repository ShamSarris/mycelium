/* eslint-disable */
// GENERATED FILE - do not edit. Source: schemas/plan.schema.json

/**
 * An existing project by id, or a new project by name.
 */
export type ProjectRef =
  | {
      id: string;
    }
  | {
      /**
       * Also the Gitea repository name, so it is slug-shaped.
       */
      name: string;
    };
/**
 * Plan-local identifier. Distinct from the database UUID assigned at submission.
 */
export type TaskId = string;
export type SuccessCriterion =
  | {
      type: 'all_tasks_done';
    }
  | {
      type: 'file_exists_in_branch';
      /**
       * Repo-relative path in plan/<id>. No leading slash, no parent traversal.
       */
      path: string;
    };
/**
 * A lowercase hostname, optionally prefixed with `*.` to cover subdomains. No scheme, port, or path: the proxy matches on the CONNECT host and allows 80/443 only.
 */
export type EgressHost = string;

/**
 * A unit of approved work. Authored by the local planning client, re-validated by the orchestrator at submission. Baseline v0.1 section 6.
 */
export interface Plan {
  /**
   * What this plan is for, in the operator's words.
   */
  goal: string;
  project: ProjectRef;
  /**
   * Echoed to the operator at the approval gate. At least one is mandatory (goal G2).
   *
   * @minItems 1
   * @maxItems 50
   */
  assumptions: string[];
  /**
   * @maxItems 50
   */
  non_goals?: string[];
  /**
   * Selects the target worker VM for the whole plan.
   */
  env: 'dev' | 'prod';
  /**
   * @minItems 1
   * @maxItems 50
   */
  tasks: Task[];
  /**
   * Declarative checks evaluated by the orchestrator at finalize.
   *
   * @minItems 1
   * @maxItems 20
   */
  success_criteria: SuccessCriterion[];
  /**
   * Hostnames this plan's sandboxes may reach through the supervisor proxy, on top of the standing set (Gitea, package registries). Plan-scoped, shown at the approval gate, and cannot widen after approval. Empty means deny everything outside the standing set.
   *
   * @maxItems 50
   */
  egress?: EgressHost[];
  /**
   * Ceiling on the tokens this whole plan may spend, across every task and every execution attempt. Omitted means the sum of the task ceilings, which is what the plan already implies; naming it is how you ask for less. The orchestrator halts the plan rather than dispatching a task that would cross it.
   */
  max_tokens?: number;
  max_concurrent_agents?: number;
  /**
   * Wall-clock lifetime of the plan environment before the supervisor tears it down.
   */
  env_ttl_min?: number;
}
export interface Task {
  id: TaskId;
  /**
   * Plain text. v1 carries no typed context capsule; large inputs live in the repo.
   */
  description: string;
  /**
   * @maxItems 50
   */
  depends_on?: TaskId[];
  limits: Limits;
  failure_policy?:
    | {
        type: 'retry';
        max_attempts: number;
      }
    | {
        type: 'halt';
      };
}
export interface Limits {
  tokens: number;
  wall_clock_min: number;
}
