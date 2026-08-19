// Route adapters. One function, two wire formats, no dependencies.
//
// The call is a plain completion: no tools, no file access, no shell. That is not a simplification, it
// is the enforcement of "propose, never decide" at the only level where it cannot be argued with. A
// model that can only return text cannot weaken a gate, push a branch, or edit a rule set, whatever a
// prompt talks it into.

const TIMEOUT_MS = 180_000;

/** Which wire format a route speaks. */
export const formatFor = (route) => (route === 'api' ? 'anthropic' : 'openai');

const post = async (url, headers, body) => {
  // Node's fetch has no default timeout, so a wedged gateway would hang the job until the runner's own
  // limit killed it, with nothing in the log to say why.
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });

  const text = await response.text();
  if (!response.ok) {
    // The body carries the useful part, e.g. a quota refusal, so it travels with the status.
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 800)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`response was not JSON: ${text.slice(0, 400)}`);
  }
};

/**
 * Ask a model for one completion.
 *
 * @returns {Promise<{text: string, usage: object|undefined, raw: object}>}
 */
export const complete = async ({ route, baseUrl, model, apiKey, system, user, maxTokens = 8000 }) => {
  if (formatFor(route) === 'anthropic') {
    const json = await post(
      `${baseUrl ?? 'https://api.anthropic.com'}/v1/messages`,
      { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] },
    );
    return {
      text: (json.content ?? []).map((part) => part.text ?? '').join(''),
      usage: json.usage,
      raw: json,
    };
  }

  const json = await post(
    `${baseUrl}/v1/chat/completions`,
    apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
  );
  return {
    text: json.choices?.[0]?.message?.content ?? '',
    usage: json.usage,
    raw: json,
  };
};

/**
 * What the route claims about the turn it just served.
 *
 * Deliberately does not assume: a gateway answering is not evidence that the turn drew the pool you
 * expected. An OAuth token posted to a first-party API while impersonating a first-party client can be
 * billed to a metered pool instead of an included one, which is a real failure with a real error
 * message attached. So whatever the response says about billing is surfaced verbatim rather than
 * interpreted, and "unknown" is an honest answer.
 */
export const billingNote = ({ raw, usage }) => {
  const overage = raw?.rate_limit?.isUsingOverage ?? raw?.usage?.isUsingOverage;
  const limitType = raw?.rate_limit?.rate_limit_type ?? raw?.rate_limit_type;
  const parts = [];
  if (usage) {
    const input = usage.input_tokens ?? usage.prompt_tokens;
    const output = usage.output_tokens ?? usage.completion_tokens;
    if (input || output) {
      parts.push(`tokens in/out: ${input ?? '?'}/${output ?? '?'}`);
    }
  }
  if (limitType) {
    parts.push(`rate limit: ${limitType}`);
  }
  if (overage !== undefined) {
    parts.push(`overage: ${overage}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'the route reported nothing about billing or limits';
};
