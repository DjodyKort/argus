import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collect, estimateTokens } from '../src/deep-read.mjs';
import { billingNote, formatFor } from '../src/model.mjs';
import { build } from '../src/packet.mjs';
import { buildSystem, buildUser, parse, render } from '../src/report.mjs';

const packet = () =>
  build({
    task: 'merge-triage',
    scope: { kind: 'range', base: 'aaaaaaaaaaaa', head: 'upstream/main', baseIsAncestor: true, commits: 3, fileCount: 9 },
    findings: [{ level: 'high', rule: 'policy', why: 'The policy module.', files: ['src/policy.ts'] }],
    invariants: [
      { id: 'bits', statement: 'Bits are persisted.', enforcedBy: 'policy.spec.ts' },
      { id: 'one-home', statement: 'Rules live in one place.' },
    ],
  });

test('the system prompt carries the prohibitions and marks what is already enforced', () => {
  const system = buildSystem(packet(), 'You are reviewing an incoming merge.');

  assert.match(system, /You are reviewing an incoming merge\./);
  assert.match(system, /already enforced by: policy\.spec\.ts/);
  assert.match(system, /not enforced by anything mechanical/);
  assert.match(system, /state a verdict/);
  assert.match(system, /Do not include a verdict/);
});

test('the system prompt says so when no invariants were supplied', () => {
  const bare = build({ task: 't', scope: { kind: 'paths', paths: ['a'] }, findings: [] });
  assert.match(buildSystem(bare, 'skill'), /None were supplied\. Say so rather than inventing some\./);
});

test('the user message announces a truncated deep read instead of hiding it', () => {
  const user = buildUser(packet(), {
    text: 'diff --git a/src/policy.ts b/src/policy.ts',
    files: ['src/policy.ts'],
    omitted: ['src/other.ts'],
    truncated: true,
  });

  assert.match(user, /Partial\. Included 1 file\(s\); omitted 1 after hitting the token ceiling/);
  assert.match(user, /src\/other\.ts/);
});

test('the user message says what an absent diff prevents concluding', () => {
  assert.match(buildUser(packet(), null), /say plainly what that prevents you from/);
});

test('parse recovers JSON from a fenced block with prose around it', () => {
  const { checks, problems } = parse(
    'Sure, here you go:\n```json\n{"checks":[{"file":"a.ts","concern":"c","how_to_check":"h","confidence":"high"}],"unverified":[]}\n```\nHope that helps.',
  );

  assert.equal(problems.length, 0);
  assert.deepEqual(checks, [{ file: 'a.ts', concern: 'c', how_to_check: 'h', confidence: 'high' }]);
});

test('parse strips a verdict and records that it did', () => {
  const { problems } = parse('{"verdict":"looks good, merge it","checks":[],"unverified":[]}');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /verdict, which was discarded/);
});

test('parse drops a malformed check rather than passing it along', () => {
  const { checks, problems } = parse('{"checks":[{"concern":"no file here"},{"file":"b.ts","concern":"ok"}]}');

  assert.equal(checks.length, 1);
  assert.equal(checks[0].file, 'b.ts');
  // An unrecognised confidence must not become "high" by accident.
  assert.equal(checks[0].confidence, 'low');
  assert.match(problems[0], /dropped a check/);
});

test('parse reports unusable output instead of throwing', () => {
  const { checks, problems, rawText } = parse('I would rather explain this in prose.');
  assert.deepEqual(checks, []);
  assert.match(problems[0], /no JSON object/);
  assert.equal(rawText, 'I would rather explain this in prose.');
});

test('render states it is not a verdict, and surfaces response problems', () => {
  const out = render({
    packet: packet(),
    report: { checks: [], unverified: ['could not read the migration'], problems: ['the response was not valid JSON'] },
    route: 'local-primary',
    detail: 'The primary gateway answered.',
    billing: 'tokens in/out: 100/50',
    deep: { files: ['src/policy.ts'], truncated: true },
  });

  assert.match(out, /Route `local-primary`/);
  assert.match(out, /No checks were raised\./);
  assert.match(out, /could not read the migration/);
  assert.match(out, /Problems with the response/);
  assert.match(out, /Deep-read 1 file\(s\), truncated/);
  assert.match(out, /not a verdict/);
});

test('formatFor keeps the metered API on its own wire format', () => {
  assert.equal(formatFor('api'), 'anthropic');
  assert.equal(formatFor('local-primary'), 'openai');
  assert.equal(formatFor('local-fallback'), 'openai');
});

test('billingNote refuses to guess when the route said nothing', () => {
  assert.match(billingNote({ raw: {}, usage: undefined }), /reported nothing about billing/);
  assert.match(billingNote({ raw: { rate_limit: { isUsingOverage: false } }, usage: { input_tokens: 10, output_tokens: 2 } }), /overage: false/);
});

test('collect returns nothing when no finding reaches a deep-read level', () => {
  const lowOnly = build({
    task: 't',
    scope: { kind: 'range', base: 'a', head: 'b' },
    findings: [{ level: 'low', why: 'w', files: ['x.ts'] }],
    budget: { deepReadLevels: ['high'] },
  });

  const deep = collect(lowOnly, { cwd: process.cwd() });
  assert.equal(deep.text, '');
  assert.deepEqual(deep.files, []);
});

test('estimateTokens is a ceiling, not a measurement', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
});
