#!/usr/bin/env node
// Une los index-<id>.json de cada build en packs/index.json, conservando las regiones
// del índice anterior que no se hayan regenerado en esta ejecución.
//   node tools/merge-index.mjs packs [old/index.json]
import { readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const [dir = 'packs', oldPath] = process.argv.slice(2);
const byId = new Map();
if (oldPath && existsSync(oldPath)) for (const r of JSON.parse(readFileSync(oldPath, 'utf8')).regions || []) byId.set(r.id, r);
for (const f of readdirSync(dir)) {
  if (!/^index-.+\.json$/.test(f)) continue;
  for (const r of JSON.parse(readFileSync(join(dir, f), 'utf8')).regions) byId.set(r.id, r);
  unlinkSync(join(dir, f));
}
const regions = [...byId.values()].sort((a, b) => (a.main - b.main) || a.name.localeCompare(b.name, 'es'));
writeFileSync(join(dir, 'index.json'), JSON.stringify({ updated: new Date().toISOString(), regions }, null, 2));
console.log(`index.json: ${regions.length} regiones`);
