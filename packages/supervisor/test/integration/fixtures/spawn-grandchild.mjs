// Fixture for cgroup.test.ts (ticket 15 / Q5). Stands in for the plan agent:
// it spawns one long-lived child process the way `@anthropic-ai/claude-agent-sdk`
// spawns the `claude` binary (a plain `child_process.spawn`, no `detached`,
// confirmed from the installed SDK's own `sdk.mjs` — `spawnLocalProcess` calls
// the platform spawn with `stdio`, `signal`, `env`, `windowsHide` only), then
// idles so it has to be killed rather than exiting on its own.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const child = spawn('sleep', ['300'], { stdio: 'ignore' });
writeFileSync(process.env.CHILD_PID_FILE, String(child.pid));

setInterval(() => {}, 60_000);
