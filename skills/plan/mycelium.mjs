#!/usr/bin/env node
/**
 * The plan skill's only piece of code: six calls to the orchestrator's operator
 * routes.
 *
 * It exists so the base URL, the identity header and the shape of a validation
 * failure live in one place rather than being retyped as `curl` in prose each
 * time — which is where a subtle mistake would go unnoticed. It holds no
 * credential, no schema, and no logic worth calling a client.
 *
 * Identity: the operator routes accept loopback connections only and take the
 * caller from a `Tailscale-User-Login` header. In deployment, Tailscale Serve
 * injects that header having stripped any client-supplied copy, and the
 * loopback rule is what makes it trustworthy. Pointed at an orchestrator on
 * your own machine there is no Serve, so the header below is self-asserted —
 * fine on your own loopback, where there is no one else, and not a deployment.
 *
 *   MYCELIUM_URL       default http://127.0.0.1:8080
 *   MYCELIUM_OPERATOR  the login to send. Must be on the orchestrator's allowlist.
 */

import { readFile } from 'node:fs/promises';

const BASE = (process.env.MYCELIUM_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const OPERATOR = process.env.MYCELIUM_OPERATOR ?? '';

const USAGE = `usage: mycelium.mjs <command> [args]

  propose <file.json>   submit a plan; prints its id, or every validation issue
  show <plan-id>        what approval covers: assumptions, non-goals, ceilings, tasks
  approve <plan-id>     approve a proposed plan
  reject <plan-id>      reject a proposed plan
  status <plan-id>      plan and per-task state, spend, and the manifest when it ends
  events <plan-id>      the event log for a plan

  MYCELIUM_URL       ${BASE}
  MYCELIUM_OPERATOR  ${OPERATOR === '' ? '(unset)' : OPERATOR}`;

function die(message) {
  console.error(message);
  process.exit(1);
}

/**
 * One request. Every failure the operator can actually cause is named here
 * rather than surfacing as a status code: an unreachable orchestrator, an
 * identity the allowlist does not carry, and a plan the schema rejected are
 * the three things that will happen, and each needs a different fix.
 */
async function call(method, path, body) {
  const url = `${BASE}${path}`;
  let response;

  try {
    response = await fetch(url, {
      method,
      headers: {
        'tailscale-user-login': OPERATOR,
        // Only when there is one: Fastify refuses an empty body that claims to
        // be JSON, and approve and reject carry nothing.
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    die(
      `the orchestrator is unreachable at ${url}\n` +
        `  ${error.message}\n` +
        '  is it running, and is MYCELIUM_URL right?',
    );
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = text === '' ? {} : JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }

  if (response.ok) return parsed;

  const error = parsed.error ?? {};

  // A schema failure comes back with the issues that caused it. Printing them
  // by path and message is the whole reason the skill validates by submitting.
  if (Array.isArray(error.issues) && error.issues.length > 0) {
    die(
      `the orchestrator rejected the plan (${error.code ?? response.status}):\n` +
        error.issues.map((issue) => `  ${issue.path ?? '/'}  ${issue.message}`).join('\n'),
    );
  }

  if (response.status === 401 || response.status === 403) {
    die(
      `the orchestrator refused ${OPERATOR === '' ? '(no operator set)' : OPERATOR}: ` +
        `${error.message ?? response.statusText}\n` +
        '  set MYCELIUM_OPERATOR to a login on the orchestrator allowlist',
    );
  }

  die(`${method} ${path} failed (${response.status}): ${error.message ?? error.code ?? text}`);
}

function line(label, value) {
  console.log(`${label.padEnd(20)}${value}`);
}

function list(label, values) {
  if (values.length === 0) {
    line(label, '(none)');
    return;
  }
  console.log(`${label}`);
  for (const value of values) console.log(`  - ${value}`);
}

async function propose(file) {
  if (file === undefined) die(USAGE);

  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    die(`could not read ${file}: ${error.message}`);
  }

  let plan;
  try {
    plan = JSON.parse(raw);
  } catch (error) {
    die(`${file} is not valid JSON: ${error.message}`);
  }

  const result = await call('POST', '/plans', plan);
  console.log(result.plan_id);
  console.log(`\nproposed. review it with:  show ${result.plan_id}`);
}

async function show(planId) {
  const { plan, tasks } = await call('GET', `/plans/${planId}`);

  console.log(`\n${plan.goal}\n`);
  line('plan', plan.id);
  line('state', plan.state);
  line('env', plan.env);
  console.log();

  list('assumptions', plan.assumptions);
  console.log();
  list('non-goals', plan.non_goals);
  console.log();
  list('egress', plan.egress);
  console.log();

  line('max tokens', plan.max_tokens);
  line('concurrency', plan.max_concurrent_agents);
  line('environment TTL', `${plan.env_ttl_min} min`);
  console.log();

  console.log('tasks');
  for (const task of tasks) {
    const spec = task.local_id;
    console.log(`  ${spec.padEnd(28)}${task.state}`);
  }
  console.log(`\napprove it with:  approve ${plan.id}`);
}

async function status(planId) {
  const { plan, tasks, manifest } = await call('GET', `/plans/${planId}`);

  line('plan', plan.id);
  line('state', plan.state);
  if (plan.terminal_reason) line('reason', plan.terminal_reason);
  console.log();

  console.log('tasks');
  for (const task of tasks) {
    const spend = task.tokens_spent > 0 ? `${task.tokens_spent} tokens` : '';
    console.log(`  ${task.local_id.padEnd(24)}${task.state.padEnd(12)}${spend}`);
    if (task.error) console.log(`  ${' '.repeat(24)}${task.error}`);
  }

  if (manifest) {
    console.log('\nmanifest');
    console.log(JSON.stringify(manifest, null, 2));
  }
}

async function events(planId) {
  const { events: rows } = await call('GET', `/events?plan_id=${encodeURIComponent(planId)}`);

  for (const event of rows) {
    const task = event.task_id ? ` ${event.task_id}` : '';
    console.log(`${event.ts}  ${event.type}${task}`);
    if (event.payload && Object.keys(event.payload).length > 0) {
      console.log(`  ${JSON.stringify(event.payload)}`);
    }
  }
  if (rows.length === 0) console.log('(no events yet)');
}

async function act(action, planId) {
  if (planId === undefined) die(USAGE);
  const result = await call('POST', `/plans/${planId}/${action}`);
  console.log(`${planId} is now ${result.state ?? action}`);
}

const [command, argument] = process.argv.slice(2);

switch (command) {
  case 'propose':
    await propose(argument);
    break;
  case 'show':
    if (argument === undefined) die(USAGE);
    await show(argument);
    break;
  case 'status':
    if (argument === undefined) die(USAGE);
    await status(argument);
    break;
  case 'events':
    if (argument === undefined) die(USAGE);
    await events(argument);
    break;
  case 'approve':
  case 'reject':
    await act(command, argument);
    break;
  case undefined:
    die(USAGE);
    break;
  default:
    die(`no such command: ${command}\n\n${USAGE}`);
}
