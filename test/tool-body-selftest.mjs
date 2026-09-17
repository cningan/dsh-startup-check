// Tool-body self-test — the layer that neither `node --check` nor a
// plugin-tree boot smoke can see.
//
// Why it exists: booting the plugin tree only proves the tree *loads*; it never
// executes the tool function body. A running harness keeps serving the code it
// booted with, so a source edit that breaks the tool body stays green until the
// next restart — at which point the first `plugin_check` call throws. This file
// closes that gap: it copies `lib/` and `assets/` into a throwaway harness under
// the OS temp directory, replaces the two `@deepseek-ai/*` imports with stubs,
// drives `apply(ctx)` and the tool's `execute()` in a **fresh Node process**,
// and fails loudly on an undefined identifier or a bad provider shape.
//
// Usage:
//   node test/tool-body-selftest.mjs                 # positive control: this repo
//   node test/tool-body-selftest.mjs --plugin <dir>  # negative control: any other plugin dir
//
// Exit code 0 = the tool body really ran. Non-zero = it threw.
//
// Boundary: the plugin source is only read, never modified. The stub harness
// lives in the OS temp directory and can be deleted at any time.

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

/** The plugin root: this file lives in `<root>/test/`. */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Files of `lib/` that make up the plugin. Keep in sync when lib/ changes. */
const LIB_FILES = ['index.js', 'smoke.js', 'page-smoke.js', 'instances.js'];

const argv = process.argv.slice(2);
const flagIndex = argv.indexOf('--plugin');
const PLUGIN = flagIndex >= 0 ? argv[flagIndex + 1] : REPO_ROOT;
if (!PLUGIN) {
  console.error('usage: node test/tool-body-selftest.mjs [--plugin <plugin-dir>]');
  process.exit(2);
}

const HARNESS = join(tmpdir(), 'dsh-startup-check-selftest');

// ---- Stub packages: make the plugin's `@deepseek-ai/*` imports resolve in bare Node ----
const stub = (pkg, body) => {
  const dir = join(HARNESS, 'node_modules/@deepseek-ai', pkg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${pkg}`, version: '0.0.0-stub', type: 'module', main: 'index.js' }));
  writeFileSync(join(dir, 'index.js'), body);
};
stub('dsh-tools', 'export function defineTool(spec) { return spec; }\n');
stub('dsh-skill', 'export const BUNDLED_SKILL_RANK = 600;\n');

// ---- Copy the plugin under test (read-only source) ----
writeFileSync(join(HARNESS, 'package.json'), JSON.stringify({ name: 'tool-body-selftest-harness', private: true, type: 'module' }));
mkdirSync(join(HARNESS, 'lib'), { recursive: true });
mkdirSync(join(HARNESS, 'assets'), { recursive: true });
for (const f of LIB_FILES) copyFileSync(join(PLUGIN, 'lib', f), join(HARNESS, 'lib', f));
copyFileSync(join(PLUGIN, 'assets/plugin-fault-diagnosis.md'), join(HARNESS, 'assets/plugin-fault-diagnosis.md'));

// ---- Stub ctx: canned fs data, no real subprocess ----
// The stub process table holds two canned DSH processes: 4242 is a leftover
// isolated smoke instance (900s old), 4243 is a live host. After a stub
// `taskkill`, 4242 disappears — so the stray-instance audit and `killStray`
// cleanup really execute here instead of merely "looking right".
const spawned = [];
const killedPids = new Set();
const fakeHandle = (out) => ({
  done: Promise.resolve({ exitCode: 0 }),
  // `collected[side].readFrom(offset)` is the real contract (byte-offset,
  // non-consuming). The stub has to honour it, or `collectedText()` would always
  // return '' and the audit would report "not measured".
  collected: {
    stdout: { readFrom: (from) => ({ text: out.slice(from), nextOffset: out.length, lossy: false }) },
    stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
  },
  terminate: () => {},
});
const STUB_PROCESS_ROWS = [
  { ProcessId: 4242, ParentProcessId: 1, AgeSeconds: 900, CommandLine: '"node" "C:\\x\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" --profile web --port 0 --no-open' },
  { ProcessId: 4243, ParentProcessId: 1, AgeSeconds: 30, CommandLine: '"node" "C:\\x\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" web --no-open' },
];
const ctx = {
  fs: {
    async resolve(p) { return { localPath: p, displayPath: p }; },
    async readText(target) {
      const p = target.localPath;
      if (p.endsWith('cordis.patch.yml')) return "plugins:\n  - name: '@local/dsh-visualize'\n  - name: '@local/dsh-oauth'\n";
      if (p.endsWith('package.json')) return JSON.stringify({ name: '@local/dsh-x', main: 'lib/index.js' });
      return '';
    },
    async listDir(target) {
      const p = target.localPath;
      if (p.endsWith('plugins')) return ['dsh-visualize', 'dsh-oauth', 'dsh-startup-check'];
      if (p.endsWith('lib')) return ['index.js'];
      return [];
    },
    processPath(target) { return target.localPath; },
  },
  subprocess: {
    spawn(spec) {
      spawned.push(spec.argv.join(' '));
      if (spec.argv[0] === 'taskkill') {
        killedPids.add(String(spec.argv[2]));
        return fakeHandle('');
      }
      if (spec.argv[0] === 'powershell') {
        const alive = STUB_PROCESS_ROWS.filter((row) => !killedPids.has(String(row.ProcessId)));
        return fakeHandle(JSON.stringify(alive));
      }
      return fakeHandle('');
    },
  },
  skills: { registered: [], registerProvider(create) { this.registered.push(create()); return () => {}; } },
  tools: { registered: [], register(tool) { this.registered.push(tool); return () => {}; } },
};

const mod = await import(pathToFileURL(join(HARNESS, 'lib/index.js')).href + '?t=' + Date.now());
console.log('plugin:', PLUGIN);
console.log('inject:', JSON.stringify(mod.inject));
mod.apply(ctx);

const tool = ctx.tools.registered[0];
console.log('tool:', tool && tool.name);
if (!tool) {
  console.error('FAIL: apply() registered no tool');
  process.exit(1);
}

const provider = ctx.skills.registered[0];
if (!provider) {
  console.error('FAIL: apply() registered no skill provider');
  process.exit(1);
}
const listed = await provider.list();
const got = await provider.get(listed[0]);
console.log('skill:', got.name, '| rank:', listed[0].rank, '| bytes:', Buffer.byteLength(got.content), '| whenToUse:', got.whenToUse ? 'yes' : 'MISSING');
if (!got.content || !got.whenToUse) {
  console.error('FAIL: bundled skill body or whenToUse is missing');
  process.exit(1);
}

const result = await tool.execute({ target: 'dsh-visualize' }, {});
console.log('execute ->', JSON.stringify(result));

// Stray-instance audit + killStray: the stub process table must be recognised,
// and cleanup must make the stray disappear.
const sweep = await tool.execute({ sweep: true }, {});
const sweepRow = (sweep.checks || []).find((c) => c.name === '残留实例审计');
console.log('sweep  ->', JSON.stringify(sweepRow));
const kill = await tool.execute({ sweep: true, killStray: true }, {});
const killRow = (kill.checks || []).find((c) => c.name === '残留实例审计');
console.log('killStray ->', JSON.stringify(killRow));
const auditOk = !!sweepRow
  && /残留隔离实例 1 个/.test(sweepRow.detail) && /4242/.test(sweepRow.detail)   // recognises the stray, and only it
  && /宿主 1 个/.test(sweepRow.detail) && /4243/.test(sweepRow.detail)          // reports the host, never touches it
  && /未清理|killStray:true/.test(sweepRow.detail)                              // default: report only
  && !!killRow && /已清理/.test(killRow.detail);                                // explicit killStray cleans up

console.log('spawned:', JSON.stringify(spawned));
console.log('VERDICT:', result && Array.isArray(result.checks) && result.checks.length >= 4 && auditOk ? 'OK' : 'SUSPECT');
process.exit(result && Array.isArray(result.checks) && result.checks.length >= 4 && auditOk ? 0 : 1);
