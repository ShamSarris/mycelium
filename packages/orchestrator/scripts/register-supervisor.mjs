#!/usr/bin/env node
/**
 * Registers a node supervisor and prints its bearer token once.
 *
 * Supervisors do not self-register: an unknown VM must not be able to join by
 * asking. Only the token hash is stored, so a lost token means registering
 * again rather than looking it up.
 *
 *   node scripts/register-supervisor.mjs --name worker-dev-1 --env dev \
 *     --url http://worker-dev-1.tailnet:8080 [--priority 100]
 */
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { v7 as uuidv7 } from 'uuid';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

const name = arg('name');
const env = arg('env', 'dev');
const baseUrl = arg('url');
const priority = Number.parseInt(arg('priority', '100'), 10);

if (!name || !baseUrl) {
  console.error('usage: register-supervisor.mjs --name <name> --env dev|prod --url <base url> [--priority n]');
  process.exit(2);
}
if (env !== 'dev' && env !== 'prod') {
  console.error(`env must be dev or prod, got ${env}`);
  process.exit(2);
}

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://mycelium:mycelium@localhost:5433/mycelium';

const token = randomBytes(32).toString('hex');
const id = uuidv7();

const client = new pg.Client({ connectionString });
await client.connect();

try {
  await client.query(
    `INSERT INTO agents (id, name, env, base_url, token_hash, enabled, priority, created_at)
     VALUES ($1, $2, $3, $4, $5, true, $6, now())`,
    [id, name, env, baseUrl, createHash('sha256').update(token, 'utf8').digest('hex'), priority],
  );
} finally {
  await client.end();
}

console.log(`supervisor id : ${id}`);
console.log(`name          : ${name} (${env}, priority ${priority})`);
console.log(`base url      : ${baseUrl}`);
console.log('');
console.log('bearer token, shown once:');
console.log(token);
