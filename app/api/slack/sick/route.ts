export const runtime = 'nodejs';
export const maxDuration = 60; // Allow up to 60 seconds for the background task

import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { after } from 'next/server';

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
  const userId = params.get('user_id');
  const userMention = userId ? `<@${userId}>` : 'Someone';

  // Immediate ACK (Slack requires <3s)
  const ack = new Response(
    JSON.stringify({
      response_type: 'in_channel',
      text: '_Calibrating immune system..._',
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    },
  );

  // Async background task using Next.js after() to keep it alive on Vercel
  if (responseUrl) {
    after(async () => {
      try {
        console.log('Starting background task with response_url:', responseUrl);
        console.log('Calling Claude API...');
        console.log('User input:', userInput);
        console.log('Claude API key present:', !!claudeKey);
        const anthropic = new Anthropic({ apiKey: claudeKey });

        const prompt = `
You are helping format a sick day message for Slack. The user provided this message about their work:
"""${userInput || '(no notes provided)'}"""

Create a response with TWO parts:

1. First line: Start with "${userMention} is out sick today" then add a brief, funny workplace-safe reason in parentheses.
   - Examples: "(caught a severe case of meetings)", "(overexposed to synergy)", "(PowerPoint poisoning)"
   - Keep it short and absurd but harmless
   - Never mention real illnesses
   - Use "${userMention}" exactly as provided (do not modify it)

2. Second paragraph: Write a third-person status update about their work, as if YOU are reporting on what THEY did/are doing.
   - Use third person pronouns (they/them/their) to refer to the person
   - Example tone: "They have been driving alignment on..." NOT "I have been driving alignment..."
   - Take the information they provided and describe it with overly corporate jargon
   - Stay close to what they actually said - preserve key details and context
   - Add buzzwords like: "drove alignment", "accelerated value delivery", "proactively de-risked", "stakeholder visibility"
   - Keep it 2-5 sentences, under 700 characters
   - If they mentioned specific work, keep those specifics but make them sound corporate

Separate the two parts with a blank line. Use plain text only (no markdown, no quotes, no labels).`;

        console.log('Making API request...');
        const apiPromise = anthropic.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 500,
          temperature: 1,
          messages: [{ role: 'user', content: prompt }],
        });

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Claude API timeout after 45s')),
            45000,
          ),
        );

        const response = await Promise.race([apiPromise, timeoutPromise]);
        console.log('API request completed');

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
            body: JSON.stringify({
              response_type: 'in_channel',
              replace_original: true,
              text,
            }),
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
              response_type: 'in_channel',
              replace_original: true,
              text: 'Feeling under the weather but continuing to synergize strategically pending AI recovery.',
            }),
          });
        } catch (fetchErr) {
          console.error('Failed to send error response to Slack:', fetchErr);
        }
      }
      console.log('Background task completed');
    });
  }

  return ack;
}
