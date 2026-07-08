export async function GET() {
  return Response.json({
    ok: true,
    name: 'LIMU MCP',
    mcp: '/api/mcp',
    protectedResource: '/.well-known/oauth-protected-resource',
  });
}
