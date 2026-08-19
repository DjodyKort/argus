// Prompt assembly, response parsing, and rendering.
//
// The response contract is small and structured on purpose: a wall of prose cannot be diffed between
// runs, cannot be counted, and cannot be checked for the one thing that matters most, which is whether
// the model stayed inside its remit.

import { render as renderPacket } from './rules.mjs';

const CONFIDENCE = new Set(['high', 'medium', 'low']);

/** The system prompt: the skill, plus the invariants and prohibitions the packet carries. */
export const buildSystem = (packet, skill) => {
  const lines = [skill.trim(), '', '## Invariants for this repository', ''];

  if (packet.invariants?.length) {
    for (const { id, statement, enforcedBy } of packet.invariants) {
      lines.push(`- **${id}**: ${statement}`);
      if (enforcedBy) {
        // Naming the gate is what keeps a turn from being spent re-deriving something mechanical.
        lines.push(`  - already enforced by: ${enforcedBy}. Do not spend effort re-deriving this.`);
      } else {
        lines.push('  - not enforced by anything mechanical. This one needs your attention.');
      }
    }
  } else {
    lines.push('None were supplied. Say so rather than inventing some.');
  }

  lines.push('', '## You must not', '');
  for (const rule of packet.output.mustNot) {
    lines.push(`- ${rule}`);
  }

  lines.push(
    '',
    '## Answer format',
    '',
    'Reply with JSON only, no prose around it, matching:',
    '',
    '```json',
    '{',
    '  "checks": [',
    '    {"file": "path", "concern": "what might be wrong", "how_to_check": "the concrete step",',
    '     "confidence": "high|medium|low"}',
    '  ],',
    '  "unverified": ["what you could not determine, and why"],',
    '  "notes": "optional, short"',
    '}',
    '```',
    '',
    'An empty `checks` array is a valid and useful answer. `unverified` is not optional padding: if the',
    'diff you were given was truncated, or a file was omitted, say what you therefore could not judge.',
    'Do not include a verdict, an approval, or a recommendation to merge.',
  );

  return lines.join('\n');
};

/** The user message: the deterministic report, then the diffs that were actually included. */
export const buildUser = (packet, deep) => {
  const lines = [renderPacket(packet), ''];

  if (deep?.text) {
    lines.push('## Diffs for the flagged files', '');
    if (deep.truncated || deep.omitted.length > 0) {
      lines.push(
        `> Partial. Included ${deep.files.length} file(s); omitted ${deep.omitted.length}` +
          `${deep.truncated ? ' after hitting the token ceiling' : ''}. Omitted: ` +
          `${deep.omitted.slice(0, 20).join(', ')}${deep.omitted.length > 20 ? ', ...' : ''}.`,
        '',
      );
    }
    lines.push('```diff', deep.text, '```');
  } else {
    lines.push(
      '## Diffs',
      '',
      'None were included, either because no finding reached a deep-read level or because the scope is',
      'not a git range. Judge from the findings above and say plainly what that prevents you from',
      'concluding.',
    );
  }

  return lines.join('\n');
};

/**
 * Parse a model response into the report shape.
 *
 * Tolerant about packaging, strict about content: a fenced block or surrounding prose is recovered from,
 * while a malformed entry is dropped and counted rather than passed along as if it were sound. A
 * `verdict` key is stripped and recorded, because the prompt forbids one and quietly honouring it would
 * make the prohibition decorative.
 */
export const parse = (text) => {
  const problems = [];
  let json = null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.search(/[{[]/);

  if (start !== -1) {
    try {
      json = JSON.parse(candidate.slice(start));
    } catch {
      problems.push('the response was not valid JSON');
    }
  } else {
    problems.push('the response contained no JSON object');
  }

  if (!json || typeof json !== 'object') {
    return { checks: [], unverified: [], problems, rawText: text };
  }

  if ('verdict' in json || 'approved' in json || 'recommendation' in json) {
    problems.push('the response contained a verdict, which was discarded: this task proposes, it does not decide');
  }

  const checks = [];
  for (const entry of Array.isArray(json.checks) ? json.checks : []) {
    const file = typeof entry?.file === 'string' ? entry.file : null;
    const concern = typeof entry?.concern === 'string' ? entry.concern : null;
    if (!file || !concern) {
      problems.push('dropped a check with no file or no concern');
      continue;
    }
    checks.push({
      file,
      concern,
      how_to_check: typeof entry.how_to_check === 'string' ? entry.how_to_check : '',
      confidence: CONFIDENCE.has(entry.confidence) ? entry.confidence : 'low',
    });
  }

  const unverified = (Array.isArray(json.unverified) ? json.unverified : []).filter(
    (item) => typeof item === 'string' && item.length > 0,
  );

  return {
    checks,
    unverified,
    notes: typeof json.notes === 'string' ? json.notes : undefined,
    problems,
    rawText: text,
  };
};

/** Render the final report. */
export const render = ({ packet, report, route, detail, billing, deep }) => {
  const lines = [`## Argus: ${packet.task}`, ''];

  lines.push(`Route \`${route}\`. ${detail ?? ''}`.trim(), '');

  if (report.checks.length === 0) {
    lines.push('No checks were raised.', '');
  } else {
    lines.push(`### Worth checking (${report.checks.length})`, '');
    for (const { file, concern, how_to_check, confidence } of report.checks) {
      lines.push(`- \`${file}\` — ${concern} _(${confidence} confidence)_`);
      if (how_to_check) {
        lines.push(`  - how: ${how_to_check}`);
      }
    }
    lines.push('');
  }

  if (report.unverified.length > 0) {
    lines.push('### Not verified', '');
    for (const item of report.unverified) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  if (report.notes) {
    lines.push(report.notes, '');
  }

  if (report.problems.length > 0) {
    // Surfaced, not swallowed: a report assembled from a partly malformed answer is worth less than one
    // that says so.
    lines.push('### Problems with the response', '');
    for (const problem of report.problems) {
      lines.push(`- ${problem}`);
    }
    lines.push('');
  }

  const footer = [`Deterministic findings: ${packet.findings.length}.`];
  if (deep) {
    footer.push(`Deep-read ${deep.files.length} file(s)${deep.truncated ? ', truncated' : ''}.`);
  }
  if (billing) {
    footer.push(billing);
  }
  footer.push('This is a to-check list, not a verdict. The gates decide.');
  lines.push('---', footer.join(' '));

  return lines.join('\n');
};
