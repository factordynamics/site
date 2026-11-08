import { LIMITS } from './keys';
import { ERRORS, SCHEMA_VERSION } from './v1';

/** OpenAPI 3.1 description of /v1, served at /v1/openapi.json. */
export function openapi() {
  const error = {
    type: 'object',
    required: ['schema_version', 'error'],
    properties: {
      schema_version: { type: 'string' },
      error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string', enum: Object.keys(ERRORS) }, message: { type: 'string' } } },
    },
  };
  const errResponses = Object.fromEntries(
    [
      ['401', 'unauthorized or invalid_key'],
      ['402', 'subscription_inactive'],
      ['403', 'pro_required'],
      ['404', 'not_found'],
      ['429', 'rate_limited'],
    ].map(([s, d]) => [s, { description: d, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }]),
  );
  return {
    openapi: '3.1.0',
    info: {
      title: 'Copybook API',
      version: SCHEMA_VERSION,
      description: `13F holdings, Form 4 and Schedule 13D/G data from SEC EDGAR, as filed. Copy Pro only. Authenticate with \`Authorization: Bearer cbk_live_...\` (create keys on your Copybook account page). Limits per key: ${LIMITS.minute} requests/minute and ${LIMITS.day} requests/day, reported in RateLimit-* and X-RateLimit-* headers; 429 responses carry Retry-After. Every response has \`schema_version\`. Error codes: ${Object.entries(ERRORS).map(([k, v]) => `\`${k}\` (${v})`).join('; ')}`,
    },
    servers: [{ url: 'https://copybook-api.factordynamics.workers.dev' }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'A Copybook API key, cbk_live_...' } },
      schemas: { Error: error },
    },
    paths: {
      '/v1/me': {
        get: {
          summary: 'The calling key and its daily request counts for the last 30 days',
          responses: { '200': { description: 'Key and usage' }, ...errResponses },
        },
      },
    } as Record<string, unknown>,
  };
}
