import { createFileRoute } from '@tanstack/react-router';
import { embed, embedMany, createGateway } from 'ai';
import { validateUserAndToken } from '@/utils/access';

export const Route = createFileRoute('/api/ai/embed')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const { user, token } = await validateUserAndToken(request.headers.get('authorization'));
          if (!user || !token) {
            return Response.json({ error: 'Not authenticated' }, { status: 403 });
          }

          const { texts, single, apiKey } = await request.json();

          if (!texts || !Array.isArray(texts) || texts.length === 0) {
            return Response.json({ error: 'Texts array required' }, { status: 400 });
          }

          const gatewayApiKey = apiKey || process.env['AI_GATEWAY_API_KEY'];
          if (!gatewayApiKey) {
            return Response.json({ error: 'API key required' }, { status: 401 });
          }

          const gateway = createGateway({ apiKey: gatewayApiKey });
          const model = gateway.embeddingModel(
            process.env['AI_GATEWAY_EMBEDDING_MODEL'] || 'openai/text-embedding-3-small',
          );

          if (single) {
            const { embedding } = await embed({ model, value: texts[0] });
            return Response.json({ embedding });
          } else {
            const { embeddings } = await embedMany({ model, values: texts });
            return Response.json({ embeddings });
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          return Response.json({ error: `Embedding failed: ${errorMessage}` }, { status: 500 });
        }
      },
    },
  },
});
