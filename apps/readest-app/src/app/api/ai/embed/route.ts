import { createFileRoute } from '@tanstack/react-router';
import { embed, embedMany, createGateway } from 'ai';
import { env } from '@/env';
import { runAuth } from '@/libs/server/route-helpers';

interface EmbedRequest {
  texts: string[];
  single?: boolean;
  apiKey?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseEmbedRequest = (body: unknown): EmbedRequest | null => {
  if (!isRecord(body) || !Array.isArray(body['texts']) || body['texts'].length === 0) {
    return null;
  }
  if (!body['texts'].every((text) => typeof text === 'string')) {
    return null;
  }
  if (body['single'] !== undefined && typeof body['single'] !== 'boolean') {
    return null;
  }
  if (body['apiKey'] !== undefined && typeof body['apiKey'] !== 'string') {
    return null;
  }
  return {
    texts: body['texts'],
    single: body['single'],
    apiKey: body['apiKey'],
  };
};

export const Route = createFileRoute('/api/ai/embed')({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runAuth(request, async () => {
          try {
            const body = parseEmbedRequest(await request.json());
            if (!body) {
              return Response.json({ error: 'Texts array required' }, { status: 400 });
            }
            const { texts, single, apiKey } = body;

            const gatewayApiKey = apiKey || env.AI_GATEWAY_API_KEY;
            if (!gatewayApiKey) {
              return Response.json({ error: 'API key required' }, { status: 401 });
            }

            const gateway = createGateway({ apiKey: gatewayApiKey });
            const model = gateway.embeddingModel(env.AI_GATEWAY_EMBEDDING_MODEL);

            if (single) {
              const { embedding } = await embed({ model, value: texts[0]! });
              return Response.json({ embedding });
            } else {
              const { embeddings } = await embedMany({ model, values: texts });
              return Response.json({ embeddings });
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return Response.json({ error: `Embedding failed: ${errorMessage}` }, { status: 500 });
          }
        }),
    },
  },
});
