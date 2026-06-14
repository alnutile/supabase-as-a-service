import Anthropic from '@anthropic-ai/sdk';

// The Anthropic key lives only on the server (Railway env var), never in the browser.
const client = new Anthropic(); // reads ANTHROPIC_API_KEY

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
const EFFORT = process.env.ANTHROPIC_EFFORT || 'medium'; // low | medium | high | max

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    names: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['name', 'rationale'],
      },
    },
  },
  required: ['names'],
};

function extractJson(message) {
  const text = (message.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse model output as JSON');
  }
}

/**
 * Ask Claude for fresh names, grounded in the brief + everything the team has
 * said and voted on so far.
 *
 * @param {object} args
 * @param {string} args.brief        Team description / what they're after.
 * @param {Array}  args.existing     [{ name, votes, source }] — names already on the board.
 * @param {Array}  args.feedback     [{ name, body }] — feedback notes (name null = general).
 * @param {number} args.count        How many new names to return.
 * @returns {Promise<Array<{name:string, rationale:string}>>}
 */
export async function generateNames({ brief, existing, feedback, count = 8 }) {
  const existingBlock = existing.length
    ? existing
        .map((n) => `- ${n.name} (${n.votes} vote${n.votes === 1 ? '' : 's'})`)
        .join('\n')
    : '(none yet)';

  const feedbackBlock = feedback.length
    ? feedback
        .map((f) => (f.name ? `- on "${f.name}": ${f.body}` : `- (general): ${f.body}`))
        .join('\n')
    : '(no feedback yet)';

  const system = `You are a sharp brand-naming partner helping a small team name themselves.
Propose distinctive, memorable, enterprise-credible names. Learn from the feedback:
lean into directions the team liked and the names that earned votes; steer away from what they rejected.
Avoid generic, cliché, or AI-slop names. Do not repeat any existing name (or trivial variants).
Each name should be short (1-2 words), easy to say, and brandable. Keep each rationale to one sentence.`;

  const prompt = `TEAM BRIEF
${brief}

NAMES ALREADY ON THE BOARD (do not repeat these):
${existingBlock}

FEEDBACK SO FAR (this is the most important signal — follow it):
${feedbackBlock}

Propose ${count} NEW names that build on what's working and address the feedback.`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: EFFORT,
      format: { type: 'json_schema', schema: SCHEMA },
    },
    system,
    messages: [{ role: 'user', content: prompt }],
  });

  if (message.stop_reason === 'refusal') {
    throw new Error('The model declined this request.');
  }

  const parsed = extractJson(message);
  return Array.isArray(parsed.names) ? parsed.names : [];
}
