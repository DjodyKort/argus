#!/usr/bin/env node
// Argus CLI. Deliberately small: it builds a packet and renders it. Choosing a model route is a
// workflow's job (.github/workflows/route.yml), and running the model is the task's job.
//
//   argus packet --task merge-triage --rules <file> [--config <file>] [--base <ref>] [--head <ref>]
//                                    [--json] [--out <file>]
//
// Exits 0 even with findings: this reports, it does not gate. Gates are the consuming repo's tests.
// Exit 2 means the invocation itself was wrong, which is a different thing and should be loud.

import { readFileSync, writeFileSync } from 'node:fs';
import { apply } from '../packages/core/src/rules.mjs';
import { build } from '../packages/core/src/packet.mjs';
import { resolveRange } from '../packages/core/src/range.mjs';
import { render } from '../packages/core/src/rules.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);

const die = (message) => {
  console.error(`argus: ${message}`);
  process.exit(2);
};

if (argv[0] !== 'packet') {
  die('usage: argus packet --task <name> --rules <file> [--config <file>] [--base <ref>] [--head <ref>] [--json] [--out <file>]');
}

const task = flag('task') ?? die('--task is required');
const rulesPath = flag('rules') ?? die('--rules is required');

const readJson = (path, what) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    die(`could not read ${what} at ${path}: ${error.message}`);
  }
};

const ruleSet = readJson(rulesPath, 'rule set');
const config = flag('config') ? readJson(flag('config'), 'config') : {};

let scope;
try {
  scope = resolveRange({ base: flag('base'), head: flag('head') });
} catch (error) {
  // A missing upstream remote or an unfetched ref is an invocation problem, not a finding.
  die(`could not resolve the range: ${error.message}`);
}

const { findings, unmatchedCount } = apply(Array.isArray(ruleSet) ? ruleSet : ruleSet.rules, scope.files);

const packet = build({
  task,
  scope,
  findings,
  invariants: config.invariants,
  budget: config.budget,
  output: config.output,
  meta: { unmatchedCount },
});

const text = has('json') ? JSON.stringify(packet, null, 2) : render(packet);
if (flag('out')) {
  writeFileSync(flag('out'), `${text}\n`);
  console.error(`argus: wrote ${flag('out')}`);
} else {
  console.log(text);
}
