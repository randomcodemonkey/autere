/**
 * OpenAPI 3 description of the autere HTTP API, generated from the route
 * table in routes.ts (docs only — matching uses the route defs directly).
 */

import { API_VERSION } from '../shared/api-paths.js';

export interface RouteDoc {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  template: string;
  role: 'chat' | 'control' | 'admin';
  tag: string;
  summary: string;
  status?: number;
}

const envelope = (dataSchema: any) => ({
  type: 'object',
  required: ['success'],
  properties: {
    success: { type: 'boolean' },
    error: { type: 'string' },
    ...dataSchema,
  },
});

const OK = (dataSchema: any = {}) => ({
  description: 'Success',
  content: {
    'application/json': {
      schema: dataSchema
        ? envelope({ data: dataSchema })
        : { type: 'object', properties: { success: { type: 'boolean' } } },
    },
  },
});

const ERR = (desc: string, status: string) => ({
  [status]: {
    description: desc,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: { success: { type: 'boolean', enum: [false] }, error: { type: 'string' } },
        },
      },
    },
  },
});

/** Convert an OpenAPI template path to the operationId method name part */
function opId(template: string, method: string): string {
  const name = template
    .replace(/^\//, '')
    .replace(/[{}]/g, '')
    .replace(/[^a-zA-Z0-9/]+/g, '-')
    .split('/')
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join('');
  return method.toLowerCase() + name;
}

export function buildOpenApiSpec(routes: RouteDoc[]) {
  const paths: Record<string, any> = {};

  for (const r of routes) {
    const params = [...r.template.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      description: 'Resource identifier',
      schema: { type: 'string' },
    })) as any[];
    const success = r.status && r.status !== 200 ? String(r.status) : '200';
    const op: any = {
      operationId: opId(r.template, r.method),
      summary: r.summary,
      tags: [r.tag],
      'x-required-role': r.role,
      responses: {
        [success]: OK({}),
        '400': ERR('Invalid input', '400'),
        '401': ERR('Unauthenticated', '401'),
        '403': ERR('Insufficient role', '403'),
        '404': ERR('Not found', '404'),
      },
    };
    if (['POST', 'PUT', 'DELETE'].includes(r.method)) {
      op.requestBody = {
        required: false,
        content: { 'application/json': { schema: { type: 'object' } } },
      };
    }
    if (params.length) op.parameters = params;
    (paths[r.template] ??= {})[r.method.toLowerCase()] = op;
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'autere API',
      version: API_VERSION,
      description:
        'Real-time dashboard API for pi agent sessions. All endpoints (except /auth/*) '
        + 'require authentication via the autere-token session cookie or '
        + '`Authorization: Bearer <token>` (API token created via POST /tokens). '
        + 'Roles form a hierarchy: chat < control < admin. The /events endpoint is '
        + 'a Server-Sent-Events stream carrying {type, data, sessionId?} frames.',
    },
    servers: [{ url: '/' }],
    tags: [...new Set(routes.map((r) => r.tag))].map((t) => ({ name: t })),
    paths,
  };
}
