// Bounded diff extraction: the mechanism behind "deep-read only what is flagged".
//
// Upstream in the first consuming repo runs 44 to 76 commits a week. Sending that diff whole is both
// expensive and worse at the job, because the interesting twenty lines arrive buried in ten thousand.
// The packet already says which findings justify reading actual code (`budget.deepReadLevels`), so this
// fetches exactly those files and stops at a token ceiling.

import { execFileSync } from 'node:child_process';

/** Rough token estimate. Four characters per token is wrong in detail and fine for a ceiling. */
export const estimateTokens = (text) => Math.ceil(text.length / 4);

/**
 * Collect diffs for the files named by findings at the requested levels.
 *
 * Truncation is announced in the output rather than silent: a model told it has the whole diff will
 * reason as if it does, and a reader trusting a complete report deserves to know it is partial.
 *
 * @returns {{text: string, files: string[], omitted: string[], truncated: boolean}}
 */
export const collect = (packet, { cwd, maxTokens = 20_000, maxFiles } = {}) => {
  const levels = new Set(packet.budget?.deepReadLevels ?? ['high']);
  const limitFiles = maxFiles ?? packet.budget?.maxFiles ?? 40;

  const wanted = [];
  for (const finding of packet.findings) {
    if (!levels.has(finding.level)) {
      continue;
    }
    for (const file of finding.files) {
      if (!wanted.includes(file)) {
        wanted.push(file);
      }
    }
  }

  if (packet.scope?.kind !== 'range' || wanted.length === 0) {
    return { text: '', files: [], omitted: wanted, truncated: false };
  }

  const range = `${packet.scope.base}..${packet.scope.head}`;
  const chunks = [];
  const included = [];
  const omitted = [];
  let tokens = 0;
  let truncated = false;

  for (const file of wanted) {
    if (included.length >= limitFiles) {
      omitted.push(file);
      truncated = true;
      continue;
    }

    let diff;
    try {
      diff = execFileSync('git', ['diff', range, '--', file], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch {
      // A file can be unreadable at this range, e.g. it arrived through a submodule. Losing one file is
      // survivable; pretending it was clean is not, so it is reported as omitted.
      omitted.push(file);
      continue;
    }

    const cost = estimateTokens(diff);
    if (tokens + cost > maxTokens) {
      omitted.push(file);
      truncated = true;
      continue;
    }

    tokens += cost;
    included.push(file);
    chunks.push(diff);
  }

  return { text: chunks.join('\n'), files: included, omitted, truncated };
};
