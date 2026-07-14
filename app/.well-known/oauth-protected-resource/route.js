import {
  LIMU_OAUTH_SCOPES,
  limuOAuthIssuer,
  mcpResourceUrl,
} from '../../../src/portal-api.js';

export async function GET(request) {
  const url = new URL(request.url);
  return Response.json(
    {
      resource: mcpResourceUrl(url.href),
      authorization_servers: [limuOAuthIssuer()],
      scopes_supported: LIMU_OAUTH_SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'LIMU MCP',
    },
    {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
        'Cache-Control': 'max-age=3600',
      },
    }
  );
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    },
  });
}
