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
  const ack = createAckResponse('_Translating to emoji..._', 'in_channel');

  // Async background task using Next.js after() to keep it alive on Vercel
  if (responseUrl) {
    after(async () => {
      try {
        console.log('Starting emojify background task');
        console.log('User input:', userInput);
        console.log('Claude API key present:', !!claudeKey);
        const anthropic = new Anthropic({ apiKey: claudeKey });

        const prompt = `
You are an emoji translator. Take the user's message and summarize its meaning using only emojis.

User's message: """${userInput || 'hello'}"""

Rules:
- Use 3-12 emojis that capture the essence/meaning of the message
- Put the emojis in a logical sequence that tells the "story"
- Be creative but accurate to the meaning
- No text, just emojis
- If the message mentions specific things (food, activities, emotions, places), include relevant emojis

Examples:
- "I'm going to the store to buy groceries" → 🚶‍♂️🏪🛒🍎🥕
- "The meeting was really long and boring" → 💼⏰😴💤
- "I shipped the code to production" → 💻✈️🏭✅🎉
- "Feeling sick, staying home" → 🤒🏠🛏️💊
- "Let's get coffee and discuss the project" → ☕💬📊💡

Output ONLY emojis, no other text or explanation.`;

        console.log('Making API request...');
        const apiPromise = anthropic.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 150,
          temperature: 0.8,
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

        const emojis = response.content
          .map((c: object) => ('text' in c ? c.text : ''))
          .join('')
          .trim();

        console.log('Claude response:', emojis);
        console.log('Sending response to Slack...');

        // Format the response with the original message
        const formattedText = userInput
          ? `💬 _"${userInput}"_\n\n${emojis}`
          : emojis;

        await sendSlackMessage(responseUrl, formattedText, 'in_channel');
      } catch (err) {
        console.error('Claude error:', err);
        try {
          await sendSlackMessage(
            responseUrl,
            '❌🤷‍♂️ (Translation failed)',
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
