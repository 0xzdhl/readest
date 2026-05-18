import { createFileRoute } from '@tanstack/react-router';
import { EdgeSpeechTTS, type EdgeTTSPayload } from '@/libs/edgeTTS';
import { validateUserAndToken } from '@/utils/access';

const getLangFromVoice = (voiceId: string): string => {
  const match = voiceId.match(/^([a-z]{2}-[A-Z]{2})/);
  return match ? match[1]! : 'en-US';
};

const isValidVoice = (voiceId: string): boolean => {
  return EdgeSpeechTTS.voices.some((v) => v.id === voiceId);
};

interface EdgeTTSRequest {
  input?: string;
  voice?: string;
  speed: number;
  rate?: number;
  lang?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseEdgeTTSRequest = (body: unknown): EdgeTTSRequest | null => {
  if (!isRecord(body)) {
    return null;
  }
  if (body['input'] !== undefined && typeof body['input'] !== 'string') {
    return null;
  }
  if (body['voice'] !== undefined && typeof body['voice'] !== 'string') {
    return null;
  }
  if (body['speed'] !== undefined && typeof body['speed'] !== 'number') {
    return null;
  }
  if (body['rate'] !== undefined && typeof body['rate'] !== 'number') {
    return null;
  }
  if (body['lang'] !== undefined && typeof body['lang'] !== 'string') {
    return null;
  }
  return {
    input: body['input'],
    voice: body['voice'],
    speed: body['speed'] ?? 1.0,
    rate: body['rate'],
    lang: body['lang'],
  };
};

export const Route = createFileRoute('/api/tts/edge')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { user, token } = await validateUserAndToken(request.headers.get('authorization'));
        if (!user || !token) {
          return Response.json({ error: 'Not authenticated' }, { status: 403 });
        }

        try {
          const body = parseEdgeTTSRequest(await request.json());
          if (!body) {
            return Response.json(
              {
                error: {
                  message: 'Invalid request body',
                  type: 'invalid_request_error',
                },
              },
              { status: 400 },
            );
          }
          const { input: text, voice, speed = 1.0 } = body;
          let { rate, lang } = body;

          if (!text || typeof text !== 'string') {
            return Response.json(
              {
                error: {
                  message: 'Missing or invalid "input" field',
                  type: 'invalid_request_error',
                },
              },
              { status: 400 },
            );
          }

          if (!voice || typeof voice !== 'string') {
            return Response.json(
              {
                error: {
                  message: 'Missing or invalid "voice" field',
                  type: 'invalid_request_error',
                },
              },
              { status: 400 },
            );
          }

          if (!isValidVoice(voice)) {
            return Response.json(
              {
                error: {
                  message: `Invalid voice "${voice}". Use GET /api/tts/edge to list available voices.`,
                  type: 'invalid_request_error',
                },
              },
              { status: 400 },
            );
          }

          lang = lang || getLangFromVoice(voice);

          // Calculate rate (OpenAI speed ranges from 0.25 to 4.0, Edge TTS rate is 0.5 to 2.0)
          const clampedSpeed = Math.max(0.25, Math.min(4.0, speed));
          let mappedSpeed: number;
          if (clampedSpeed <= 1.0) {
            mappedSpeed = 0.5 + ((clampedSpeed - 0.25) / (1.0 - 0.25)) * (1.0 - 0.5);
          } else {
            mappedSpeed = 1.0 + ((clampedSpeed - 1.0) / (4.0 - 1.0)) * (2.0 - 1.0);
          }
          rate = rate || mappedSpeed;

          const payload: EdgeTTSPayload = {
            lang,
            text,
            voice,
            rate,
            pitch: 1.0,
          };

          const tts = new EdgeSpeechTTS();
          const response = await tts.create(payload);
          const arrayBuffer = await response.arrayBuffer();

          return new Response(arrayBuffer, {
            status: 200,
            headers: {
              'Content-Type': 'audio/mpeg',
              'Content-Length': arrayBuffer.byteLength.toString(),
            },
          });
        } catch (error) {
          console.error('Edge TTS API error:', error);
          return Response.json(
            {
              error: {
                message: error instanceof Error ? error.message : 'Internal server error',
                type: 'internal_error',
              },
            },
            { status: 500 },
          );
        }
      },

      GET: async ({ request }) => {
        const { user, token } = await validateUserAndToken(request.headers.get('authorization'));
        if (!user || !token) {
          return Response.json({ error: 'Not authenticated' }, { status: 403 });
        }

        try {
          const url = new URL(request.url);
          const lang = url.searchParams.get('lang') || '';
          let voices = EdgeSpeechTTS.voices;
          if (lang) {
            voices = voices.filter((v) => v.lang.toLowerCase().includes(lang.toLowerCase()));
          }

          const formattedVoices = voices.map((voice) => ({
            id: voice.id,
            name: voice.name,
            language: voice.lang,
          }));

          return Response.json({
            voices: formattedVoices,
          });
        } catch (error) {
          console.error('Error listing voices:', error);
          return Response.json(
            {
              error: {
                message: 'Failed to list voices',
                type: 'internal_error',
              },
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
