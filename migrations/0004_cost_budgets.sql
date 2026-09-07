-- Cost-denominated budgets (spec D30). Cost is authoritative; tokens remain as
-- profile-local detail because they are not comparable across providers
-- (future_work/database.md:41, :59).
--
-- bigint, not integer: microusd overflows int4 at $2,147.48. Every sum() over
-- this column must cast ::bigint, never ::int.
--
-- tasks.tokens_spent is untouched — it stays integer, and stays the
-- profile-local detail figure beside the now-authoritative cost figure.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS cost_spent_microusd bigint NOT NULL DEFAULT 0;

-- Only the `_spent` half of future_work/database.md:41's four-column design
-- (tokens_reserved/tokens_spent + cost_reserved_microusd/cost_spent_microusd)
-- is added here. The Agent SDK cannot reserve before a call, so there is
-- nothing for a `cost_reserved_microusd` column to hold yet — deliberately
-- not added (see ticket 04 §9).

-- ---------------------------------------------------------------------------
-- JSONB rewrite: plans.spec and tasks.spec embed the token-denominated fields
-- verbatim (the validated plan document is stored as-is). Renamed here:
--   plans.spec.max_tokens                    -> plans.spec.max_cost_microusd
--   plans.spec.max_concurrent_agents         -> removed
--   plans.spec.tasks[].limits.tokens         -> ...limits.cost_microusd
--   tasks.spec.limits.tokens                 -> tasks.spec.limits.cost_microusd
--
-- plans.manifest is NOT touched: it holds historical, immutable
-- tokens_spent totals for plans that already finished, and readers of it
-- stay dual-read (ticket 04 §9) rather than have this migration rewrite
-- history.
--
-- Decision on rows with no max_tokens (ticket 04 §6.2/§9): there is no price
-- table in the database to convert an absent tokens ceiling into a cost
-- ceiling, so no numeric value can be invented for it. `plans` and `tasks`
-- are provably empty in every environment this migration has been run
-- against (README: no plan has ever completed end to end) and every row in
-- them is a smoke-test fixture, so a plan row that has neither the old
-- `max_tokens` key nor the new `max_cost_microusd` key (meaning: not
-- convertible, and not already migrated either) is deleted outright rather
-- than given a sentinel value that would silently understate or overstate
-- its real budget. Its tasks and dependency edges are deleted with it so the
-- migration cannot fail on a foreign key. This branch is expected to affect
-- zero rows in practice; it exists so the migration cannot error if that
-- assumption is ever wrong, and it logs when it fires.
DO $$
DECLARE
  orphaned_plan_ids uuid[];
BEGIN
  SELECT array_agg(id) INTO orphaned_plan_ids
  FROM plans
  WHERE NOT (spec ? 'max_tokens') AND NOT (spec ? 'max_cost_microusd');

  IF orphaned_plan_ids IS NOT NULL THEN
    RAISE NOTICE
      '0004_cost_budgets: deleting % plan(s) with no max_tokens and no max_cost_microusd (no price table to convert with): %',
      array_length(orphaned_plan_ids, 1), orphaned_plan_ids;

    DELETE FROM task_dependencies
      WHERE task_id IN (SELECT id FROM tasks WHERE plan_id = ANY (orphaned_plan_ids))
         OR depends_on_task_id IN (SELECT id FROM tasks WHERE plan_id = ANY (orphaned_plan_ids));
    DELETE FROM tasks WHERE plan_id = ANY (orphaned_plan_ids);
    DELETE FROM plans WHERE id = ANY (orphaned_plan_ids);
  END IF;
END $$;

-- plans.spec: max_tokens -> max_cost_microusd, drop max_concurrent_agents.
-- Guarded by `? 'max_tokens'` so a re-run (where the key is already gone) is
-- a no-op.
UPDATE plans
SET spec = (spec - 'max_tokens' - 'max_concurrent_agents')
           || jsonb_build_object('max_cost_microusd', spec -> 'max_tokens')
WHERE spec ? 'max_tokens';

-- plans.spec -> tasks[] -> limits.tokens -> limits.cost_microusd. Guarded by
-- an EXISTS check over the array so a re-run is a no-op.
UPDATE plans
SET spec = jsonb_set(
  spec,
  '{tasks}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN task_elem -> 'limits' ? 'tokens' THEN
          jsonb_set(
            task_elem,
            '{limits}',
            ((task_elem -> 'limits') - 'tokens')
              || jsonb_build_object('cost_microusd', task_elem -> 'limits' -> 'tokens')
          )
        ELSE task_elem
      END
      ORDER BY ordinality
    )
    FROM jsonb_array_elements(spec -> 'tasks') WITH ORDINALITY AS t (task_elem, ordinality)
  )
)
WHERE spec ? 'tasks'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(spec -> 'tasks') AS t (task_elem)
    WHERE t.task_elem -> 'limits' ? 'tokens'
  );

-- tasks.spec.limits.tokens -> tasks.spec.limits.cost_microusd. Guarded by
-- `? 'limits'` and the nested key check so a re-run is a no-op.
UPDATE tasks
SET spec = jsonb_set(
  spec,
  '{limits}',
  ((spec -> 'limits') - 'tokens')
    || jsonb_build_object('cost_microusd', spec -> 'limits' -> 'tokens')
)
WHERE spec ? 'limits' AND spec -> 'limits' ? 'tokens';
