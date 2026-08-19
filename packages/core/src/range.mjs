// Git range resolution, with the one trap that bit us in practice guarded.
//
// `git diff a..b` is symmetric: it reports the local side's own work as changed too, because the other
// side does not have it. Used for "what is about to arrive", that turns a report about incoming changes
// into a report that also lists everything the fork has ever written. Measured on a real merge: 347
// files and 11 high-risk findings the wrong way, 195 and 4 the right way. The wrong version is worse
// than useless because it looks authoritative, so `baseIsAncestor` travels in the packet and the
// renderer says so out loud.

import { execFileSync } from 'node:child_process';

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

/** True when `base` is an ancestor of `head`, i.e. the range is purely incoming. */
export const isAncestor = (base, head, cwd) => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', base, head], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/**
 * Resolve a range into the scope half of a packet.
 *
 * With no base, the merge-base of HEAD and head is used, which is the range that answers "what is
 * about to arrive" rather than "how do these two branches differ".
 */
export const resolveRange = ({ base, head, cwd } = {}) => {
  const resolvedHead = head ?? 'upstream/main';
  const resolvedBase = base ?? git(['merge-base', 'HEAD', resolvedHead], cwd);

  const files = git(['diff', '--name-only', `${resolvedBase}..${resolvedHead}`], cwd)
    .split('\n')
    .filter(Boolean);

  return {
    kind: 'range',
    base: resolvedBase,
    head: resolvedHead,
    baseIsAncestor: isAncestor(resolvedBase, resolvedHead, cwd),
    commits: Number(git(['rev-list', '--count', `${resolvedBase}..${resolvedHead}`], cwd)),
    fileCount: files.length,
    files,
  };
};
