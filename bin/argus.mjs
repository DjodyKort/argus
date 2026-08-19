#!/usr/bin/env node
// Argus CLI.
//
//   argus packet --task <name> --rules <file> [--config <file>] [--base <ref>] [--head <ref>]
//                [--json] [--out <file>]
//   argus run    --packet <file> --skill <file> --route <route> [--base-url <url>] [--model <name>]
//                [--out <file>]
//
// Exit codes carry meaning. 0 means the run completed, findings or not, because this reports and does
// not gate; the consuming repo's tests are what gate. 2 means the invocation was wrong, which is a
// different thing and is meant to be loud. A model being unavailable is deliberately *not* a failure:
// the deterministic report is written and the reason is recorded in it.

import { readFileSync, writeFileSync } from 'node:fs';
import { collect } from '../packages/core/src/deep-read.mjs';
import { billingNote, complete } from '../packages/core/src/model.mjs';
import { build, validate } from '../packages/core/src/packet.mjs';
import { render as renderReport, buildSystem, buildUser, parse } from '../packages/core/src/report.mjs';
import { apply, render as renderPacket } from '../packages/core/src/rules.mjs';
import { resolveRange } from '../packages/core/src/range.mjs';

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

const readJson = (path, what) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    die(`could not read ${what} at ${path}: ${error.message}`);
  }
};

const emit = (text) => {
  if (flag('out')) {
    writeFileSync(flag('out'), `${text}\n`);
    console.error(`argus: wrote ${flag('out')}`);
  } else {
    console.log(text);
  }
};

const cmdPacket = () => {
  const task = flag('task') ?? die('--task is required');
  const rulesPath = flag('rules') ?? die('--rules is required');
  const ruleSet = readJson(rulesPath, 'rule set');
  const config = flag('config') ? readJson(flag('config'), 'config') : {};

  let scope;
  try {
    scope = resolveRange({ base: flag('base'), head: flag('head') });
  } catch (error) {
    // A missing remote or an unfetched ref is an invocation problem, not a finding.
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

  emit(has('json') ? JSON.stringify(packet, null, 2) : renderPacket(packet));
};

const cmdRun = async () => {
  const packetPath = flag('packet') ?? die('--packet is required');
  const skillPath = flag('skill') ?? die('--skill is required');
  const route = flag('route') ?? die('--route is required');

  const packet = validate(readJson(packetPath, 'packet'));
  let skill;
  try {
    skill = readFileSync(skillPath, 'utf8');
  } catch (error) {
    die(`could not read the skill at ${skillPath}: ${error.message}`);
  }

  // No route is a first-class outcome. The deterministic report still ships, which is the whole reason
  // it was built first.
  if (route === 'none') {
    emit(
      [
        renderPacket(packet),
        '',
        '---',
        'No model route was available, so nothing above was reviewed by one. The findings are the',
        'deterministic pass only, and the gates are unaffected.',
      ].join('\n'),
    );
    return;
  }

  const apiKey = process.env.ARGUS_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (route === 'api' && !apiKey) {
    die('route "api" needs ANTHROPIC_API_KEY (or ARGUS_API_KEY) in the environment');
  }

  const baseUrl = flag('base-url') ?? process.env.ARGUS_BASE_URL;
  if (route !== 'api' && !baseUrl) {
    die(`route "${route}" needs --base-url (or ARGUS_BASE_URL), e.g. http://127.0.0.1:8130`);
  }

  const deep = collect(packet, { cwd: process.cwd(), maxTokens: packet.budget?.maxTokens ?? 20_000 });
  const system = buildSystem(packet, skill);
  const user = buildUser(packet, deep);

  let answer;
  try {
    answer = await complete({
      route,
      baseUrl,
      apiKey,
      model: flag('model') ?? process.env.ARGUS_MODEL ?? 'claude-sonnet-5',
      system,
      user,
    });
  } catch (error) {
    // A refused or unreachable route must not fail the caller: a quota policy stopping autonomous work
    // is normal operation, and the deterministic report is still worth shipping.
    emit(
      [
        renderPacket(packet),
        '',
        '---',
        `Route \`${route}\` did not serve a turn: ${error.message}`,
        '',
        'The findings above are the deterministic pass only. Nothing was reviewed by a model, and the',
        'gates are unaffected.',
      ].join('\n'),
    );
    return;
  }

  emit(
    renderReport({
      packet,
      report: parse(answer.text),
      route,
      detail: flag('detail'),
      billing: billingNote(answer),
      deep,
    }),
  );
};

const command = argv[0];
if (command === 'packet') {
  cmdPacket();
} else if (command === 'run') {
  await cmdRun();
} else {
  die(
    'usage:\n' +
      '  argus packet --task <name> --rules <file> [--config <file>] [--base <ref>] [--head <ref>] [--json] [--out <file>]\n' +
      '  argus run --packet <file> --skill <file> --route <route> [--base-url <url>] [--model <name>] [--out <file>]',
  );
}
