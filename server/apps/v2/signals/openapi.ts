import { SIGNAL_SIZE_MAX, SIGNAL_SOURCE_MAX_CHARS, SIGNAL_TARGETS_MAX } from './payload.js';

const SWAGGER_UI_DIST = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14';

const price = { type: 'number', exclusiveMinimum: 0 } as const;

const payloadSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['symbol', 'entry', 'targets', 'stop'],
  properties: {
    symbol: { type: 'string', pattern: '^[A-Z]{1,5}(?:\\.[A-Z]{1,2})?$', example: 'INTC' },
    entry: {
      description:
        'A price, or a zone [low, high]. US longs only: stop < entry (zone low) < every target.',
      oneOf: [price, { type: 'array', items: price, minItems: 2, maxItems: 2 }],
      example: 24.5,
    },
    targets: {
      type: 'array',
      items: price,
      minItems: 1,
      maxItems: SIGNAL_TARGETS_MAX,
      description: 'Strictly ascending, all above the entry.',
      example: [26, 28, 30],
    },
    stop: { ...price, example: 23 },
    size: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: SIGNAL_SIZE_MAX,
      description: 'Recorded only: paper sizes every signal at full risk.',
    },
    trail_after: { ...price, description: 'Recorded only: trailing is not implemented.' },
    source: {
      type: 'string',
      maxLength: SIGNAL_SOURCE_MAX_CHARS,
      pattern: '^[A-Za-z0-9 _.:@/-]+$',
    },
    received_at: {
      type: 'string',
      format: 'date-time',
      description: "The sender's timestamp, with a zone. The server stamps its own receipt time.",
    },
  },
} as const;

const eventSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['queued', 'processed', 'refused', 'failed'] },
    detail: { type: 'string' },
    recorded_at: { type: 'string', format: 'date-time' },
  },
} as const;

const signalSchema = {
  type: 'object',
  properties: {
    signal_id: { type: 'string', format: 'uuid' },
    symbol: { type: 'string' },
    entry: payloadSchema.properties.entry,
    targets: { type: 'array', items: { type: 'number' } },
    stop: { type: 'number' },
    size: { type: 'number', nullable: true },
    trail_after: { type: 'number', nullable: true },
    source: { type: 'string', nullable: true },
    sent_at: { type: 'string', format: 'date-time', nullable: true },
    received_at: { type: 'string', format: 'date-time' },
    session: {
      type: 'string',
      enum: ['in_session', 'out_of_session'],
      description: 'Whether the US regular session was open when the signal arrived.',
    },
    process_after: {
      type: 'string',
      format: 'date-time',
      description: 'Receipt time in session, else the next US session open.',
    },
    status: eventSchema.properties.status,
    events: { type: 'array', items: { $ref: '#/components/schemas/SignalEvent' } },
  },
} as const;

const error = {
  description: 'Refused',
  content: {
    'application/json': {
      schema: { type: 'object', properties: { error: { type: 'string' } } },
    },
  },
} as const;

function json(schema: object, description: string) {
  return { description, content: { 'application/json': { schema } } };
}

const signalRef = { $ref: '#/components/schemas/Signal' };
const postResponse = {
  type: 'object',
  properties: { signal: signalRef, replayed: { type: 'boolean' } },
};

export function signalsOpenApi(serverUrl: string): object {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Samurai v2 external signals',
      version: '1',
      description:
        'Loopback only and unauthenticated until the VPS move brings an auth service (#1941). ' +
        'A POST stores the signal and queues it; nothing trades from this endpoint yet.',
    },
    servers: [{ url: serverUrl }],
    paths: {
      '/api/v2/signals': {
        post: {
          summary: 'Submit a signal',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SignalPayload' } },
            },
          },
          responses: {
            201: json(postResponse, 'Stored and queued'),
            200: json(postResponse, 'Same payload already stored: the stored signal, replayed'),
            400: error,
            403: error,
            413: error,
            415: error,
          },
        },
        get: {
          summary: 'List signals, newest first',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            },
          ],
          responses: {
            200: json(
              { type: 'object', properties: { signals: { type: 'array', items: signalRef } } },
              'Signals',
            ),
            400: error,
          },
        },
      },
      '/api/v2/signals/{id}': {
        get: {
          summary: 'One signal with its status history',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: json(signalRef, 'The signal'), 404: error },
        },
      },
    },
    components: {
      schemas: { SignalPayload: payloadSchema, Signal: signalSchema, SignalEvent: eventSchema },
    },
  };
}

export const SWAGGER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Samurai v2 signals API</title>
<link rel="stylesheet" href="${SWAGGER_UI_DIST}/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="${SWAGGER_UI_DIST}/swagger-ui-bundle.js"></script>
<script>window.ui = SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui' });</script>
</body>
</html>
`;
