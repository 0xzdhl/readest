import { createFileRoute } from '@tanstack/react-router';
import { runAuth } from '@/libs/server/route-helpers';
import { streamText, createGateway } from 'ai';
import type { ModelMessage } from 'ai';
import { isRecord } from '@/utils/unknown';

const isModelMessageArray = (value: unknown): value is ModelMessage[] => Array.isArray(value);

export const Route = createFileRoute('/api/ai/chat')({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runAuth(request, async () => {
          try {
            const body: unknown = await request.json();
            if (!isRecord(body)) {
              return new Response(JSON.stringify({ error: 'Invalid request body' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
              });
            }

            const { messages, system, apiKey, model } = body;

            if (!isModelMessageArray(messages)) {
              return new Response(JSON.stringify({ error: 'Messages required' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
              });
            }

            const gatewayApiKey =
              typeof apiKey === 'string' && apiKey ? apiKey : process.env['AI_GATEWAY_API_KEY'];
            if (!gatewayApiKey) {
              return new Response(JSON.stringify({ error: 'API key required' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
              });
            }

            const gateway = createGateway({ apiKey: gatewayApiKey });
            const languageModel = gateway(
              typeof model === 'string' && model ? model : 'google/gemini-2.5-flash-lite',
            );

            const result = streamText({
              model: languageModel,
              system:
                typeof system === 'string' && system ? system : 'You are a helpful assistant.',
              messages,
            });

            return result.toTextStreamResponse();
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return new Response(JSON.stringify({ error: `Chat failed: ${errorMessage}` }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }),
    },
  },
});
