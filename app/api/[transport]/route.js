import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { registerRemoteTools } from '../../../src/remote-tools.js';
import { verifyLimuToken } from '../../../src/portal-api.js';

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
  async (_request, bearerToken) => verifyLimuToken(bearerToken),
  {
    required: true,
    resourceMetadataPath: '/.well-known/oauth-protected-resource',
  }
);

export { authHandler as GET, authHandler as POST };
