export const runtime = 'nodejs';
export const maxDuration = 60;

import Anthropic from '@anthropic-ai/sdk';
import { after } from 'next/server';
import {
  validateSlackRequest,
  sendSlackMessage,
  createAckResponse,
} from '../utils';

export async function POST(req: Request) {
  // Validate request and handle URL verification
  const validation = await validateSlackRequest(req);
  if ('error' in validation) {
    return validation.error;
  }

  const { rawBody, claudeKey } = validation;

  const params = new URLSearchParams(rawBody);
  const responseUrl = params.get('response_url');
  const userInput = (params.get('text') ?? '').trim();

  // Immediate ACK (Slack requires <3s)
  const ack = createAckResponse('_Consulting the almanac..._', 'in_channel');

  // Async background task using Next.js after() to keep it alive on Vercel
  if (responseUrl) {
    after(async () => {
      try {
        console.log('Starting farming advice background task');
        console.log('User input:', userInput);
        console.log('Claude API key present:', !!claudeKey);
        const anthropic = new Anthropic({ apiKey: claudeKey });

        const prompt = `
You are a quirky farming advisor giving hilariously bad (or occasionally accurate) farming advice.

The user asked: """${userInput || 'general farming advice'}"""

Generate a short piece of farming advice (2-4 sentences) that is:
- Absurdly funny but workplace-safe
- May or may not be accurate (mix of real and ridiculous)
- Delivered in a deadpan, serious tone as if it's legitimate advice
- Can include specific crops, animals, techniques, weather wisdom, etc.
- Sometimes completely wrong in hilarious ways
- Sometimes accidentally correct but explained weirdly

Examples of the tone:
- "Remember: cows prefer jazz music during milking, but only on Tuesdays. Classical music will curdle the milk."
- "Plant your tomatoes during a full moon while wearing rubber boots. The boots don't help the tomatoes, but they'll keep your feet dry."
- "Chickens are actually solar-powered. That's why they wake up with the sun. Common mistake is trying to charge them with USB."

Keep it short, punchy, and funny. Output plain text only (no markdown, no quotes, no labels).`;

        console.log('Making API request...');
        const apiPromise = anthropic.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 300,
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

        // Format the response with the user's query if provided
        const formattedText = userInput
          ? `🚜 *Farming Advice: ${userInput}*\n\n${text}`
          : `🚜 ${text}`;

        await sendSlackMessage(responseUrl, formattedText, 'in_channel');
      } catch (err) {
        console.error('Claude error:', err);
        try {
          await sendSlackMessage(
            responseUrl,
            '🚜 The crops have failed. Try rotating your keyboard 90 degrees and planting again.',
            'in_channel',
          );
        } catch (fetchErr) {
          console.error('Failed to send error response to Slack:', fetchErr);
        }
      }
      console.log('Background task completed');
    });
  }

  return ack;
}
