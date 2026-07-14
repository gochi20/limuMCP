import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { registerRemoteTools } from '../../../src/remote-tools.js';
import { mcpResourceUrl, verifyLimuToken } from '../../../src/portal-api.js';

const handler = createMcpHandler(
  (server) => {
    registerRemoteTools(server);
  },
  {},
  {
    basePath: '/api',
    maxDuration: 60,
    verboseLogs: process.env.NODE_ENV !== 'production',
  }
);

const authHandler = withMcpAuth(
  handler,
  async (request, bearerToken) => verifyLimuToken(bearerToken, mcpResourceUrl(request)),
  {
    required: true,
    resourceMetadataPath: '/.well-known/oauth-protected-resource',
  }
);

export { authHandler as GET, authHandler as POST };
