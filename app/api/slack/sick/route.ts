export const runtime = 'nodejs';

import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';

/** Slack signature verification */
function verifySlackSignature({
  signingSecret,
  timestamp,
  signature,
  rawBody,
}: {
  signingSecret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
}) {
  if (!timestamp || !signature) return false;
  const fiveMinutes = 60 * 5;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > fiveMinutes) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto
    .createHmac('sha256', signingSecret)
    .update(base)
    .digest('hex');
  const expected = `v0=${hmac}`;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const claudeKey = process.env.CLAUDE_API_KEY;
  if (!signingSecret || !claudeKey)
    return new Response('Missing env vars', { status: 500 });

  const rawBody = await req.text();
  const sig = req.headers.get('x-slack-signature');
  const ts = req.headers.get('x-slack-request-timestamp');

  // Slack URL verification edge case
  const maybeParams = new URLSearchParams(rawBody);
  if (maybeParams.get('type') === 'url_verification') {
    return new Response(maybeParams.get('challenge') ?? '', { status: 200 });
  }

  if (process.env.NODE_ENV === 'production') {
    if (
      !verifySlackSignature({
        signingSecret,
        timestamp: ts,
        signature: sig,
        rawBody,
      })
    ) {
      return new Response('Bad signature', { status: 401 });
    }
  }

  const params = new URLSearchParams(rawBody);
  const responseUrl = params.get('response_url');
  const userInput = (params.get('text') ?? '').trim();

  // Immediate ACK (Slack requires <3s)
  const ack = new Response(
    JSON.stringify({
      response_type: 'ephemeral',
      text: '_Calibrating immune system..._',
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    },
  );

  // Async background task
  if (responseUrl) {
    console.log('Starting async task with response_url:', responseUrl);
    (async () => {
      try {
        console.log('Calling Claude API...');
        const anthropic = new Anthropic({ apiKey: claudeKey });

        const prompt = `
            You take a short Slack message from someone who is *home sick* and rewrite it as:
            1. A single-sentence funny, harmless reason for why they’re sick.
              - Absurd but workplace-safe (e.g., "caught a severe case of meetings", "overexposed to synergy").
              - Never mention real illnesses or gross details.
            2. A second paragraph of *overly corporate jargon* expanding on their work.
              - Same meaning, just drenched in corporate buzzwords like:
                "drove alignment", "accelerated value delivery", "proactively de-risked", "stakeholder visibility", etc.
              - 3–6 sentences max.
              - Single paragraph total under 900 characters.
            3. Output both parts as plain text, separated by a blank line.
            Do not include markdown formatting, quotes, or labels.
            User’s input: """${userInput || '(no notes provided)'}"""`;

        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 500,
          temperature: 1,
          messages: [{ role: 'user', content: prompt }],
        });

        
        const text = response.content
        .map((c: object) => ('text' in c ? c.text : ''))
        .join('')
        .trim();
        
        console.log('Claude response:', text);
        console.log('Sending response to Slack...');
        try {
          const slackResponse = await fetch(responseUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ response_type: 'ephemeral', text }),
          });
          console.log('Slack response status:', slackResponse.status);
          const responseText = await slackResponse.text();
          console.log('Slack response body:', responseText);
        } catch (fetchErr) {
          console.error('Failed to send response to Slack:', fetchErr);
        }
      } catch (err) {
        console.error('Claude error:', err);
        try {
          await fetch(responseUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({
              response_type: 'ephemeral',
              text: 'Feeling under the weather but continuing to synergize strategically pending AI recovery.',
            }),
          });
        } catch (fetchErr) {
          console.error('Failed to send error response to Slack:', fetchErr);
        }
      }
      console.log('Async task completed');
    })();
  }

  return ack;
}
