#!/usr/bin/env node
/**
 * A stand-in for Gitea, only for the smoke run in the README.
 *
 * There is no Gitea instance until `infra/` exists, but approval genuinely
 * needs one: it creates the plan branch and the bot token. This answers the
 * handful of endpoints HttpGiteaClient calls, in memory, so the control flow
 * can be exercised end to end. It is not a fixture for the test suite, which
 * uses an in-process fake instead.
 *
 *   node scripts/stub-gitea.mjs [--port 3000]
 */
import { createServer } from 'node:http';

const portIndex = process.argv.indexOf('--port');
const port = portIndex === -1 ? 3000 : Number.parseInt(process.argv[portIndex + 1], 10);

const repos = new Set();

function send(res, status, body) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://stub');
  const path = url.pathname;
  console.log(`${req.method} ${req.url}`);

  // GET /api/v1/repos/{owner}/{repo}
  let match = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)$/.exec(path);
  if (match && req.method === 'GET') {
    const [, owner, repo] = match;
    if (!repos.has(repo)) return send(res, 404, { message: 'not found' });
    return send(res, 200, { clone_url: `http://localhost:${port}/${owner}/${repo}.git` });
  }

  // POST /api/v1/orgs/{org}/repos - the client creates under a named owner, so the
  // clone_url it gets back is the one the lookup above will answer with later.
  match = /^\/api\/v1\/orgs\/([^/]+)\/repos$/.exec(path);
  if (match && req.method === 'POST') {
    const [, org] = match;
    return readJson(req, (body) => {
      repos.add(body.name);
      send(res, 201, { clone_url: `http://localhost:${port}/${org}/${body.name}.git` });
    });
  }

  if (/^\/api\/v1\/repos\/[^/]+\/[^/]+\/branches$/.test(path) && req.method === 'POST') {
    return send(res, 201, {});
  }

  // GET /api/v1/repos/{owner}/{repo}/branches/{branch}
  match = /^\/api\/v1\/repos\/[^/]+\/[^/]+\/branches\/(.+)$/.exec(path);
  if (match && req.method === 'GET') {
    // main and the plan branch report the same sha, so the smoke run takes the
    // "nothing was pushed" path and the manifest carries a null pull request.
    return send(res, 200, { commit: { id: '0000000000000000000000000000000000000000' } });
  }

  if (path === '/api/v1/admin/users' && req.method === 'POST') return send(res, 201, {});
  if (/^\/api\/v1\/admin\/users\/.+$/.test(path) && req.method === 'DELETE') {
    return send(res, 204, {});
  }
  if (/^\/api\/v1\/repos\/[^/]+\/[^/]+\/collaborators\/.+$/.test(path) && req.method === 'PUT') {
    return send(res, 204, {});
  }
  if (/^\/api\/v1\/users\/[^/]+\/tokens$/.test(path) && req.method === 'POST') {
    return send(res, 201, { sha1: `stub-token-${Math.random().toString(36).slice(2)}` });
  }
  if (/^\/api\/v1\/repos\/[^/]+\/[^/]+\/contents\/.+$/.test(path)) {
    return send(res, 404, { message: 'not found' });
  }

  send(res, 404, { message: `stub gitea has no route for ${req.method} ${path}` });
});

function readJson(req, done) {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    try {
      done(raw === '' ? {} : JSON.parse(raw));
    } catch {
      done({});
    }
  });
}

server.listen(port, '127.0.0.1', () => {
  console.log(`stub gitea listening on http://127.0.0.1:${port}`);
});
