// Regenerates src/generated/*.ts from schemas/. Output is committed so consumers
// need no build step to read types. Run with: pnpm --filter @mycelium/contracts generate
import { compileFromFile } from 'json-schema-to-typescript';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src', 'generated');
await mkdir(outDir, { recursive: true });

const banner = '/* eslint-disable */\n// GENERATED FILE - do not edit. Source: schemas/%s\n';

for (const name of ['plan', 'event']) {
  const ts = await compileFromFile(join(root, 'schemas', `${name}.schema.json`), {
    bannerComment: banner.replace('%s', `${name}.schema.json`),
    additionalProperties: false,
    // Bounds stay in the schema and are enforced by ajv at runtime; expanding
    // them into tuple types produces unreadable output for no safety gain.
    ignoreMinAndMaxItems: true,
    style: { singleQuote: true },
  });
  await writeFile(join(outDir, `${name}.ts`), ts, 'utf8');
  console.log(`generated src/generated/${name}.ts`);
}
