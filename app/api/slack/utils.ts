import crypto from 'crypto';

/** Slack signature verification */
export function verifySlackSignature({
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

/** Validate Slack request and handle URL verification */
export async function validateSlackRequest(req: Request) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const claudeKey = process.env.CLAUDE_API_KEY;
  
  if (!signingSecret || !claudeKey) {
    return { error: new Response('Missing env vars', { status: 500 }) };
  }

  const rawBody = await req.text();
  const sig = req.headers.get('x-slack-signature');
  const ts = req.headers.get('x-slack-request-timestamp');

  // Slack URL verification edge case
  const maybeParams = new URLSearchParams(rawBody);
  if (maybeParams.get('type') === 'url_verification') {
    return { 
      error: new Response(maybeParams.get('challenge') ?? '', { status: 200 }) 
    };
  }

  // Verify signature in production
  if (process.env.NODE_ENV === 'production') {
    if (
      !verifySlackSignature({
        signingSecret,
        timestamp: ts,
        signature: sig,
        rawBody,
      })
    ) {
      return { error: new Response('Bad signature', { status: 401 }) };
    }
  }

  return { rawBody, claudeKey };
}

/** Send a message to Slack via response_url */
export async function sendSlackMessage(
  responseUrl: string,
  text: string,
  responseType: 'ephemeral' | 'in_channel' = 'in_channel'
) {
  try {
    const slackResponse = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        response_type: responseType,
        text,
      }),
    });
    console.log('Slack response status:', slackResponse.status);
    const responseText = await slackResponse.text();
    console.log('Slack response body:', responseText);
    return slackResponse;
  } catch (err) {
    console.error('Failed to send response to Slack:', err);
    throw err;
  }
}

/** Create an immediate acknowledgment response */
export function createAckResponse(text: string, responseType: 'ephemeral' | 'in_channel' = 'ephemeral') {
  return new Response(
    JSON.stringify({
      response_type: responseType,
      text,
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    },
  );
}

