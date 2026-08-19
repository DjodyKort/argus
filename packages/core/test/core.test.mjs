import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build, validate } from '../src/packet.mjs';
import { apply, compile, render } from '../src/rules.mjs';

const RULES = [
  { id: 'policy', level: 'high', match: '^src/policy\\.ts$', why: 'The policy module. Check every surface.' },
  { id: 'repos', level: 'medium', match: '^src/repositories/', why: 'A repository. Check the predicates.' },
];

test('compile rejects a rule set that would silently match nothing', () => {
  // A bad pattern is the dangerous case: it matches nothing, which reads as "all clear".
  assert.throws(() => compile([{ id: 'a', level: 'high', match: '([', why: 'x' }]), /bad match pattern/);
  assert.throws(() => compile([{ id: 'a', level: 'nope', match: 'x', why: 'y' }]), /level must be one of/);
  assert.throws(() => compile([]), /non-empty/);
});

test('compile rejects duplicate ids, so a noisy rule stays findable', () => {
  const dup = [...RULES, { ...RULES[0], why: 'other' }];
  assert.throws(() => compile(dup), /duplicate rule id/);
});

test('apply groups by reason and orders high before medium', () => {
  const { findings, unmatchedCount } = apply(RULES, [
    'src/policy.ts',
    'src/repositories/a.ts',
    'src/repositories/b.ts',
    'README.md',
  ]);

  assert.equal(findings.length, 2);
  assert.equal(findings[0].level, 'high');
  assert.deepEqual(findings[1].files, ['src/repositories/a.ts', 'src/repositories/b.ts']);
  assert.equal(unmatchedCount, 1);
});

test('apply uses first match, so rule order carries meaning', () => {
  const ordered = [
    { id: 'specific', level: 'high', match: '^src/repositories/asset\\.ts$', why: 'The asset one.' },
    { id: 'general', level: 'medium', match: '^src/repositories/', why: 'Any repository.' },
  ];
  const { findings } = apply(ordered, ['src/repositories/asset.ts']);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'specific');
});

test('build refuses a packet that opted out of the platform prohibitions', () => {
  const scope = { kind: 'range', base: 'a', head: 'b', baseIsAncestor: true, commits: 1, fileCount: 1 };

  // "Propose, never decide" must not be removable by omission, which is why the default is non-empty
  // and an explicit empty array is rejected.
  assert.throws(() => build({ task: 't', scope, findings: [], output: { shape: 'checklist', mustNot: [] } }), /mustNot/);

  const packet = build({ task: 't', scope, findings: [] });
  assert.ok(packet.output.mustNot.length >= 1);
  assert.ok(packet.output.mustNot.some((rule) => /verdict/.test(rule)));
});

test('validate refuses an unknown packet version', () => {
  assert.throws(() => validate({ version: 99, task: 't' }), /unsupported version/);
});

test('validate refuses a finding with no reason', () => {
  const scope = { kind: 'range' };
  assert.throws(
    () => build({ task: 't', scope, findings: [{ level: 'high', why: '', files: ['a'] }] }),
    /must say what to check/,
  );
});

test('build drops scope.files so the file list has one home', () => {
  const packet = build({
    task: 't',
    scope: { kind: 'range', files: ['a', 'b'] },
    findings: [{ level: 'low', why: 'w', files: ['a'] }],
  });

  assert.equal(packet.scope.files, undefined);
});

test('render warns when the range is not purely incoming', () => {
  const packet = build({
    task: 'merge-triage',
    scope: { kind: 'range', base: 'aaaaaaaaaaaaaaa', head: 'upstream/main', baseIsAncestor: false, commits: 30, fileCount: 347 },
    findings: [],
  });

  assert.match(render(packet), /not purely incoming/);
});

test('render says an empty result is not a clean bill of health', () => {
  const packet = build({ task: 't', scope: { kind: 'range', base: 'a', head: 'b' }, findings: [] });
  assert.match(render(packet), /not a clean bill of health/);
});
