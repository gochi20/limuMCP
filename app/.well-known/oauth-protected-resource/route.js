import {
  metadataCorsOptionsRequestHandler,
  protectedResourceHandler,
} from 'mcp-handler';
import { limuOAuthIssuer } from '../../../src/portal-api.js';

const handler = protectedResourceHandler({
  authServerUrls: [limuOAuthIssuer()],
});

const corsHandler = metadataCorsOptionsRequestHandler();

export { handler as GET, corsHandler as OPTIONS };
