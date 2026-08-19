// The rules engine: changed paths in, findings out.
//
// This is the generic half of what started life as a fork-specific script. A rule set says which paths
// matter and why; nothing here knows what a fork, a review or a sweep is. Rule sets live in the
// consuming repo, because they encode what that repo actually guarantees, and that is the part which
// must never be generic.

/**
 * @typedef {object} Rule
 * @property {string} id            Stable id, so a noisy rule can be found and fixed.
 * @property {'high'|'medium'|'low'} level
 * @property {string} match         Regular expression source, matched against the repo-relative path.
 * @property {string} why           What to check and why it matters. Not a restatement of the path.
 */

const LEVELS = ['high', 'medium', 'low'];

/** Compile a rule set, failing loudly on a bad rule rather than silently matching nothing. */
export const compile = (rules) => {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('rule set must be a non-empty array');
  }

  const seen = new Set();
  return rules.map((rule, i) => {
    for (const field of ['id', 'level', 'match', 'why']) {
      if (typeof rule?.[field] !== 'string' || rule[field].length === 0) {
        throw new Error(`rule ${i}: missing or empty "${field}"`);
      }
    }
    if (!LEVELS.includes(rule.level)) {
      throw new Error(`rule ${rule.id}: level must be one of ${LEVELS.join(', ')}`);
    }
    if (seen.has(rule.id)) {
      throw new Error(`duplicate rule id "${rule.id}"`);
    }
    seen.add(rule.id);

    let regex;
    try {
      regex = new RegExp(rule.match);
    } catch (error) {
      // A rule that cannot compile would otherwise match nothing, which reads as "all clear".
      throw new Error(`rule ${rule.id}: bad match pattern: ${error.message}`);
    }

    return { ...rule, regex };
  });
};

/**
 * Apply a rule set to a list of paths.
 *
 * First match wins, so order carries meaning: put specific rules above general ones. Findings are
 * grouped by reason rather than emitted per file, because forty paths sharing one instruction printed
 * forty times is what turns a report into something people skim.
 *
 * @returns {{findings: Array, matchedCount: number, unmatchedCount: number}}
 */
export const apply = (rules, paths) => {
  const compiled = Array.isArray(rules) && rules[0]?.regex ? rules : compile(rules);
  const groups = new Map();
  let matchedCount = 0;

  for (const path of paths) {
    const rule = compiled.find(({ regex }) => regex.test(path));
    if (!rule) {
      continue;
    }
    matchedCount++;
    const key = rule.id;
    if (!groups.has(key)) {
      groups.set(key, { level: rule.level, rule: rule.id, why: rule.why, files: [] });
    }
    groups.get(key).files.push(path);
  }

  const findings = [...groups.values()].sort(
    (a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || a.rule.localeCompare(b.rule),
  );

  return { findings, matchedCount, unmatchedCount: paths.length - matchedCount };
};

/** Render findings as markdown, for a PR comment or an issue body. */
export const render = (packet) => {
  const lines = [`## ${packet.task}`, ''];
  const { scope, findings } = packet;

  if (scope.kind === 'range') {
    lines.push(
      `\`${String(scope.base).slice(0, 12)}..${scope.head}\` - **${scope.commits ?? '?'}** commit(s), ` +
        `**${scope.fileCount ?? '?'}** file(s) changed.`,
      '',
    );
    if (scope.baseIsAncestor === false) {
      lines.push(
        '> **This range is not purely incoming.** The base is not an ancestor of the head, so `git diff`' +
          " also reports the local side's own work, which makes the report look authoritative while" +
          ' listing files nobody is about to merge.',
        '',
      );
    }
  }

  if (findings.length === 0) {
    lines.push(
      'No path matched a rule. That is not a clean bill of health: it means the rule set matched nothing,',
      'and a genuinely new kind of change would not match either. The gates remain what decide.',
    );
    return lines.join('\n');
  }

  for (const level of LEVELS) {
    const atLevel = findings.filter((f) => f.level === level);
    if (atLevel.length === 0) {
      continue;
    }
    // Both numbers, because either alone misleads: reasons say how many distinct things to think
    // about, files say how much there is. A single count invites reading it as the other one.
    const fileCount = atLevel.reduce((total, { files }) => total + files.length, 0);
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    lines.push(`### ${level} (${plural(atLevel.length, 'reason')}, ${plural(fileCount, 'file')})`, '');
    for (const { why, files } of atLevel) {
      lines.push(`- ${why}`);
      for (const file of files.slice(0, 12)) {
        lines.push(`  - \`${file}\``);
      }
      if (files.length > 12) {
        lines.push(`  - ...and ${files.length - 12} more`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
};
