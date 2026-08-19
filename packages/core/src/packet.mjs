// Build and check a work packet.
//
// Validation is hand-written rather than schema-driven on purpose: core has no dependencies, so it runs
// on any runner with node and nothing else. schemas/packet.schema.json remains the published contract;
// this enforces the parts a consumer can actually get wrong.

export const PACKET_VERSION = 1;

const LEVELS = new Set(['high', 'medium', 'low']);
const SHAPES = new Set(['checklist', 'findings', 'patch-proposal']);
const SINKS = new Set(['pr-comment', 'issue', 'artifact']);

/**
 * Assemble a packet. `scope.files` is dropped: the file list lives in the findings, and carrying a
 * second copy invites the two disagreeing.
 */
export const build = ({ task, scope, findings, invariants, budget, output, meta }) => {
  const { files, ...scopeRest } = scope ?? {};
  const packet = {
    version: PACKET_VERSION,
    task,
    scope: scopeRest,
    findings: findings ?? [],
    ...(invariants ? { invariants } : {}),
    ...(budget ? { budget } : {}),
    output: {
      shape: output?.shape ?? 'checklist',
      ...(output?.sink ? { sink: output.sink } : {}),
      mustNot: output?.mustNot ?? [
        // Defaults, because these are the failure modes that make an automated reviewer worth
        // distrusting. A task may add to them; nothing should remove them.
        'weaken, skip or delete a test or gate to make it pass',
        'state a verdict; report what to check and what you could not verify',
        'claim a result you did not observe',
      ],
    },
    ...(meta ? { meta } : {}),
  };

  validate(packet);
  return packet;
};

/** Throw on anything a consumer could plausibly get wrong. Silence here becomes a bad report later. */
export const validate = (packet) => {
  const fail = (message) => {
    throw new Error(`invalid packet: ${message}`);
  };

  if (packet?.version !== PACKET_VERSION) {
    // Refusing an unknown version is the point of having one.
    fail(`unsupported version ${packet?.version}, expected ${PACKET_VERSION}`);
  }
  if (typeof packet.task !== 'string' || !/^[a-z][a-z0-9-]*$/.test(packet.task)) {
    fail('task must be a lowercase kebab-case name');
  }
  if (!['range', 'diff', 'paths'].includes(packet.scope?.kind)) {
    fail('scope.kind must be range, diff or paths');
  }
  if (!Array.isArray(packet.findings)) {
    fail('findings must be an array');
  }
  for (const [i, finding] of packet.findings.entries()) {
    if (!LEVELS.has(finding?.level)) {
      fail(`findings[${i}].level must be high, medium or low`);
    }
    if (typeof finding.why !== 'string' || finding.why.length === 0) {
      fail(`findings[${i}].why must say what to check and why`);
    }
    if (!Array.isArray(finding.files) || finding.files.length === 0) {
      fail(`findings[${i}].files must name at least one path`);
    }
  }
  if (!SHAPES.has(packet.output?.shape)) {
    fail(`output.shape must be one of ${[...SHAPES].join(', ')}`);
  }
  if (packet.output.sink !== undefined && !SINKS.has(packet.output.sink)) {
    fail(`output.sink must be one of ${[...SINKS].join(', ')}`);
  }
  if (!Array.isArray(packet.output.mustNot) || packet.output.mustNot.length === 0) {
    // "Propose, never decide" is a platform invariant, so it cannot be opted out of by omission.
    fail('output.mustNot must carry at least one prohibition');
  }
  return packet;
};
