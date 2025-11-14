/**
 * ChatGPT Apps SDK Hello World with Auth0 and Comprehensive Debugging
 */

// Load environment variables from .env file
import 'dotenv/config';

import http from 'node:http';
import { URL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { authenticateRequest, AuthenticatedUser } from './auth.js';
import { logger } from './logger.js';

const config = loadConfig();

type SessionRecord = {
  server: McpServer;
  transport: SSEServerTransport;
  authInfo: AuthenticatedUser;
  createdAt: string;
};

const sessions = new Map<string, SessionRecord>();

// Helper to create an MCP server instance with tools
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'chatgpt-auth0-hello',
    version: '1.0.0'
  });

  // Log all server events
  server.onerror = (error) => {
    logger.error('mcp', 'MCP server error', { error: String(error) });
  };

  server.tool(
    'hello_world',
    {
      name: {
        type: 'string',
        description: 'Optional name to greet'
      }
    },
    async (args: { name?: string } | undefined, extra) => {
      const auth = (extra?.authInfo as AuthenticatedUser | undefined) ?? null;
      const greetName = typeof args?.name === 'string' && args.name.length > 0 ? args.name : 'friend';
      const userLine = auth ? ` Authenticated as ${auth.userId} (${auth.email || 'no email'}).` : ' (Not authenticated)';

      logger.info('mcp', `Tool invoked: hello_world`, { args, userId: auth?.userId });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Hello, ${greetName}!${userLine}`
          }
        ]
      };
    }
  );

  logger.debug('mcp', 'Created MCP server instance');
  return server;
}

// Manifest endpoint
function getManifest() {
  const base = config.baseUrl.replace(/\/$/, '');
  const stream = `${base}${config.ssePath}`;
  const messages = `${base}${config.sseMessagesPath}`;

  return {
    name: 'ChatGPT Auth0 Hello World',
    version: '1.0.0',
    description: 'Minimal MCP server with Auth0 OAuth and comprehensive debugging',
    contactEmail: 'dev@example.com',
    tools: [
      {
        name: 'hello_world',
        description: 'Greet the authenticated user or a provided name. Demonstrates Auth0 OAuth integration.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name to greet (optional)'
            }
          }
        }
      }
    ],
    servers: [
      {
        type: 'mcp',
        name: 'chatgpt-auth0-hello-sse',
        url: stream,
        healthUrl: `${base}/healthz`,
        transport: {
          type: 'sse',
          stream,
          messages
        },
        auth: {
          type: 'oauth',
          scopes: config.auth0.scopes,
          authorizationServer: `${base}/.well-known/oauth-authorization-server`
        }
      }
    ]
  };
}

// OAuth authorization server metadata (OpenID Discovery)
function getAuthorizationMetadata() {
  const metadata: any = {
    issuer: config.auth0.issuer,
    authorization_endpoint: config.auth0.authorizationEndpoint,
    token_endpoint: config.auth0.tokenEndpoint,
    jwks_uri: config.auth0.jwksUri,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: config.auth0.scopes,
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    claims_supported: ['aud', 'exp', 'iat', 'iss', 'sub', 'email', 'email_verified', 'scope'],
    service_documentation: `${config.baseUrl}/manifest.json`
  };

  // Add registration_endpoint if DCR is available
  if (config.auth0.registrationEndpoint) {
    metadata.registration_endpoint = config.auth0.registrationEndpoint;
  }

  // Add client_id if using static client (no DCR)
  if (config.auth0.clientId && config.auth0.clientId !== 'YOUR_CLIENT_ID_HERE') {
    metadata.client_id = config.auth0.clientId;
  }

  return metadata;
}

// Protected resource metadata
function getProtectedResourceMetadata() {
  return {
    resource: config.baseUrl,
    authorization_servers: [config.auth0.issuer],
    jwks_uri: config.auth0.jwksUri,
    scopes_supported: config.auth0.scopes,
    resource_documentation: `${config.baseUrl}/manifest.json`
  };
}

// Handle MCP connection (both Streamable HTTP POST and legacy SSE GET)
async function handleMcpConnection(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestId: string
) {
  const isStreamableHttp = req.method === 'POST';
  const protocol = isStreamableHttp ? 'Streamable HTTP' : 'SSE (legacy)';

  logger.info('mcp', `${protocol} connection requested`, {
    method: req.method,
    accept: req.headers.accept,
    origin: req.headers.origin
  }, requestId);

  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

  // Authenticate the request
  const authInfo = await authenticateRequest(req, res, config, requestId);
  if (!authInfo) {
    logger.warn('mcp', `${protocol} connection rejected - authentication failed`, undefined, requestId);
    return;
  }

  // Create appropriate transport based on protocol
  let transport: SSEServerTransport | StreamableHTTPServerTransport;

  if (isStreamableHttp) {
    // Streamable HTTP transport (modern, recommended)
    transport = new StreamableHTTPServerTransport(res, {
      allowedHosts: config.allowedHosts,
      allowedOrigins: config.allowedOrigins,
      enableDnsRebindingProtection: true
    });
    logger.debug('mcp', 'Created Streamable HTTP transport', undefined, requestId);
  } else {
    // SSE transport (legacy fallback)
    if (!(req.headers.accept ?? '').includes('text/event-stream')) {
      logger.warn('sse', 'Client does not accept text/event-stream', { accept: req.headers.accept }, requestId);
      res.writeHead(406, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Client must accept text/event-stream' }));
      return;
    }

    transport = new SSEServerTransport(config.sseMessagesPath, res, {
      allowedHosts: config.allowedHosts,
      allowedOrigins: config.allowedOrigins,
      enableDnsRebindingProtection: true
    });
    logger.debug('mcp', 'Created SSE transport', undefined, requestId);
  }

  // Monitor response stream writes
  const originalWrite = res.write.bind(res);
  res.write = function(...args: any[]) {
    logger.debug('sse', 'SSE stream writing data', {
      dataPreview: typeof args[0] === 'string' ? args[0].substring(0, 200) : '<binary>',
      sessionId: transport.sessionId
    }, requestId);
    return originalWrite(...args);
  };

  // Create a new MCP server instance for this connection
  const sessionServer = createMcpServer();

  // Clean up on response close (native Node.js event)
  res.on('close', async () => {
    logger.info('mcp', `${protocol} connection closed by client`, { sessionId: transport.sessionId }, requestId);
    sessions.delete(transport.sessionId);
    await sessionServer.close();
  });

  try {
    logger.debug('mcp', `Connecting MCP server to ${protocol} transport...`, undefined, requestId);

    // Connect the MCP server to the transport
    await sessionServer.connect(transport);
    logger.debug('mcp', 'MCP server connected to transport', { sessionId: transport.sessionId }, requestId);

    // For Streamable HTTP, we need to handle the POST request
    if (isStreamableHttp) {
      // Read the POST body
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });

      await new Promise<void>((resolve) => {
        req.on('end', () => {
          logger.debug('mcp', 'Streamable HTTP POST body received', {
            bodyPreview: body.substring(0, 200)
          }, requestId);
          resolve();
        });
      });

      // Parse and handle the request
      const parsedBody = body ? JSON.parse(body) : undefined;
      await (transport as StreamableHTTPServerTransport).handleRequest(req, res, parsedBody);

      logger.debug('mcp', 'Streamable HTTP request processed', undefined, requestId);
    }

    sessions.set(transport.sessionId, {
      server: sessionServer,
      transport,
      authInfo,
      createdAt: new Date().toISOString()
    });
    logger.info('sse', `✅ SSE session established`, {
      sessionId: transport.sessionId,
      userId: authInfo.userId,
      totalSessions: sessions.size
    }, requestId);
  } catch (error) {
    logger.error('sse', 'Failed to establish SSE session', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    }, requestId);
    sessions.delete(transport.sessionId);
    await sessionServer.close();
    if (!res.headersSent) {
      res.writeHead(500).end('Failed to start SSE session');
    }
  }
}

// Handle SSE messages (POST /mcp/sse/messages?sessionId=...)
async function handleSseMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  requestId: string
) {
  const sessionId = url.searchParams.get('sessionId');

  logger.debug('sse', 'SSE message received', { sessionId }, requestId);

  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, mcp-session-id');

  if (!sessionId) {
    logger.warn('sse', 'Missing sessionId parameter', undefined, requestId);
    res.writeHead(400).end('Missing sessionId');
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    logger.warn('sse', 'Unknown session', { sessionId, availableSessions: Array.from(sessions.keys()) }, requestId);
    res.writeHead(404).end('Unknown session');
    return;
  }

  // Attach auth info to request for MCP tools
  (req as any).authInfo = session.authInfo;

  try {
    // Read and log the message body
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });

    req.on('end', async () => {
      logger.debug('mcp', 'MCP message body', { body: body.substring(0, 500) }, requestId);

      // Parse the JSON body
      let parsedBody: any;
      try {
        parsedBody = JSON.parse(body);
        logger.debug('mcp', 'Parsed MCP message', { method: parsedBody.method, id: parsedBody.id }, requestId);
      } catch (err) {
        logger.error('mcp', 'Failed to parse JSON body', { body, error: String(err) }, requestId);
        res.writeHead(400).end('Invalid JSON');
        return;
      }

      // Pass the original req, res, and parsed body to handlePostMessage
      try {
        logger.debug('mcp', 'Calling transport.handlePostMessage...', { sessionId }, requestId);
        await session.transport.handlePostMessage(req, res, parsedBody);
        logger.debug('sse', 'SSE message processed successfully', { sessionId }, requestId);
      } catch (err) {
        logger.error('mcp', 'Error in handlePostMessage', {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          sessionId
        }, requestId);
        if (!res.headersSent) {
          res.writeHead(500).end('Error processing message');
        }
      }
    });
  } catch (error) {
    logger.error('sse', 'Failed to handle SSE message', {
      error: error instanceof Error ? error.message : String(error),
      sessionId
    }, requestId);
    if (!res.headersSent) {
      res.writeHead(500).end('Failed to process message');
    }
  }
}

// Log viewer endpoint
function handleDebugLogs(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const level = url.searchParams.get('level') as any;
  const category = url.searchParams.get('category') as any;
  const since = url.searchParams.get('since') || undefined;
  const format = url.searchParams.get('format') || 'html';

  const logs = logger.getLogs({ level, category, since });

  if (format === 'json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ logs, total: logs.length }, null, 2));
    return;
  }

  // HTML format with styling
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Debug Logs - ChatGPT Auth0 Hello World</title>
  <style>
    body { font-family: monospace; background: #1e1e1e; color: #d4d4d4; padding: 20px; }
    h1 { color: #4ec9b0; }
    .controls { margin-bottom: 20px; padding: 10px; background: #252526; border-radius: 4px; }
    .controls label { margin-right: 10px; color: #9cdcfe; }
    .controls select, .controls button { margin-right: 15px; padding: 5px; background: #3c3c3c; color: #d4d4d4; border: 1px solid #555; }
    .log-entry { margin: 10px 0; padding: 10px; background: #252526; border-left: 3px solid #666; border-radius: 3px; }
    .log-entry.debug { border-left-color: #4fc3f7; }
    .log-entry.info { border-left-color: #66bb6a; }
    .log-entry.warn { border-left-color: #ffa726; }
    .log-entry.error { border-left-color: #ef5350; }
    .log-header { display: flex; justify-content: space-between; margin-bottom: 5px; }
    .log-level { font-weight: bold; text-transform: uppercase; }
    .log-category { color: #9cdcfe; }
    .log-timestamp { color: #858585; font-size: 0.9em; }
    .log-message { color: #ce9178; margin: 5px 0; }
    .log-data { background: #1e1e1e; padding: 10px; border-radius: 3px; margin-top: 5px; overflow-x: auto; }
    .log-data pre { margin: 0; color: #d4d4d4; }
    .stats { background: #252526; padding: 10px; border-radius: 4px; margin-bottom: 20px; }
    .stats span { margin-right: 20px; }
  </style>
</head>
<body>
  <h1>🔍 Debug Logs</h1>

  <div class="stats">
    <span><strong>Total Logs:</strong> ${logs.length}</span>
    <span><strong>Sessions:</strong> ${sessions.size}</span>
    <span><strong>Server:</strong> Running</span>
  </div>

  <div class="controls">
    <label>Filter:
      <select id="levelFilter" onchange="updateFilter()">
        <option value="">All Levels</option>
        <option value="debug">Debug</option>
        <option value="info">Info</option>
        <option value="warn">Warn</option>
        <option value="error">Error</option>
      </select>
    </label>

    <label>Category:
      <select id="categoryFilter" onchange="updateFilter()">
        <option value="">All Categories</option>
        <option value="http">HTTP</option>
        <option value="oauth">OAuth</option>
        <option value="sse">SSE</option>
        <option value="mcp">MCP</option>
        <option value="auth">Auth</option>
        <option value="config">Config</option>
        <option value="error">Error</option>
      </select>
    </label>

    <button onclick="location.reload()">Refresh</button>
    <button onclick="clearLogs()">Clear Logs</button>
    <button onclick="location.href='/debug/logs?format=json'">Download JSON</button>
  </div>

  <div id="logs">
    ${logs.map(log => `
      <div class="log-entry ${log.level}" data-level="${log.level}" data-category="${log.category}">
        <div class="log-header">
          <div>
            <span class="log-level">[${log.level}]</span>
            <span class="log-category">[${log.category}]</span>
            ${log.requestId ? `<span class="log-requestid">[${log.requestId}]</span>` : ''}
          </div>
          <span class="log-timestamp">${log.timestamp}</span>
        </div>
        <div class="log-message">${escapeHtml(log.message)}</div>
        ${log.data ? `<div class="log-data"><pre>${escapeHtml(JSON.stringify(log.data, null, 2))}</pre></div>` : ''}
      </div>
    `).join('')}
  </div>

  <script>
    function updateFilter() {
      const level = document.getElementById('levelFilter').value;
      const category = document.getElementById('categoryFilter').value;
      const params = new URLSearchParams();
      if (level) params.set('level', level);
      if (category) params.set('category', category);
      window.location.search = params.toString();
    }

    function clearLogs() {
      if (confirm('Clear all logs?')) {
        fetch('/debug/logs/clear', { method: 'POST' })
          .then(() => location.reload());
      }
    }

    // Auto-refresh every 5 seconds
    setTimeout(() => location.reload(), 5000);
  </script>
</body>
</html>
  `.trim();

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Main HTTP server
const server = http.createServer(async (req, res) => {
  const requestId = logger.generateRequestId();
  const startTime = Date.now();

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Log all incoming requests
  logger.info('http', `${req.method} ${url.pathname}${url.search}`, {
    headers: req.headers,
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    origin: req.headers.origin,
    userAgent: req.headers['user-agent']
  }, requestId);

  // Handle CORS preflight
  if (req.method === 'OPTIONS' && (url.pathname === config.ssePath || url.pathname === config.sseMessagesPath)) {
    logger.debug('http', 'CORS preflight request', { pathname: url.pathname }, requestId);
    res.writeHead(204, {
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, content-type, mcp-session-id',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  try {
    // Route handling
    if (url.pathname === '/healthz') {
      res.statusCode = 200;
      res.end('ok');
      logger.debug('http', 'Health check OK', undefined, requestId);
      return;
    }

    if (url.pathname === '/manifest.json') {
      const manifest = getManifest();
      logger.info('oauth', 'Manifest requested', { manifest }, requestId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(manifest, null, 2));
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'chatgpt-auth0-hello',
        sessions: sessions.size,
        endpoints: {
          manifest: '/manifest.json',
          health: '/healthz',
          logs: '/debug/logs',
          authMetadata: '/.well-known/oauth-authorization-server',
          protectedResource: '/.well-known/oauth-protected-resource'
        }
      }, null, 2));
      return;
    }

    if (url.pathname === '/.well-known/oauth-authorization-server') {
      const metadata = getAuthorizationMetadata();
      logger.info('oauth', '📋 Authorization server metadata requested', { metadata }, requestId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metadata, null, 2));
      return;
    }

    if (url.pathname === '/.well-known/oauth-protected-resource') {
      const metadata = getProtectedResourceMetadata();
      logger.info('oauth', '🔒 Protected resource metadata requested', { metadata }, requestId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metadata, null, 2));
      return;
    }

    if (url.pathname === '/debug/logs') {
      handleDebugLogs(req, res, url);
      return;
    }

    if (url.pathname === '/debug/logs/clear' && req.method === 'POST') {
      logger.clear();
      res.writeHead(200).end('Logs cleared');
      return;
    }

    if ((req.method === 'GET' || req.method === 'POST') && url.pathname === config.ssePath) {
      await handleMcpConnection(req, res, requestId);
      return;
    }

    if (req.method === 'POST' && url.pathname === config.sseMessagesPath) {
      await handleSseMessage(req, res, url, requestId);
      return;
    }

    // 404
    logger.warn('http', 'Route not found', { pathname: url.pathname }, requestId);
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found', path: url.pathname }));

  } catch (error) {
    logger.error('error', 'Unhandled error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    }, requestId);

    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  } finally {
    const duration = Date.now() - startTime;
    logger.debug('http', `Request completed in ${duration}ms`, { statusCode: res.statusCode, duration }, requestId);
  }
});

server.listen(config.port, config.host, () => {
  logger.info('config', `
╔═══════════════════════════════════════════════════════════════════════════╗
║  🚀 ChatGPT Auth0 Hello World MCP Server                                 ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  Server:     http://${config.host}:${config.port}${' '.repeat(Math.max(0, 51 - config.host.length - String(config.port).length))}║
║  Public URL: ${config.baseUrl}${' '.repeat(Math.max(0, 58 - config.baseUrl.length))}║
╠═══════════════════════════════════════════════════════════════════════════╣
║  📋 Endpoints:                                                            ║
║    Manifest:     ${config.baseUrl}/manifest.json${' '.repeat(Math.max(0, 39 - config.baseUrl.length))}║
║    Health:       ${config.baseUrl}/healthz${' '.repeat(Math.max(0, 45 - config.baseUrl.length))}║
║    Debug Logs:   ${config.baseUrl}/debug/logs${' '.repeat(Math.max(0, 42 - config.baseUrl.length))}║
║    SSE Stream:   ${config.baseUrl}${config.ssePath}${' '.repeat(Math.max(0, 50 - config.baseUrl.length - config.ssePath.length))}║
║    SSE Messages: ${config.baseUrl}${config.sseMessagesPath}?sessionId=...${' '.repeat(Math.max(0, 28 - config.baseUrl.length - config.sseMessagesPath.length))}║
╠═══════════════════════════════════════════════════════════════════════════╣
║  🔐 Auth0:                                                                ║
║    Issuer:   ${config.auth0.issuer}${' '.repeat(Math.max(0, 60 - config.auth0.issuer.length))}║
║    Audience: ${config.auth0.audience}${' '.repeat(Math.max(0, 60 - config.auth0.audience.length))}║
║    Scopes:   ${config.auth0.scopes.join(', ')}${' '.repeat(Math.max(0, 60 - config.auth0.scopes.join(', ').length))}║
╠═══════════════════════════════════════════════════════════════════════════╣
║  💡 Next Steps:                                                           ║
║    1. Open debug logs: ${config.baseUrl}/debug/logs${' '.repeat(Math.max(0, 31 - config.baseUrl.length))}║
║    2. Configure Auth0 (see SETUP.md)                                      ║
║    3. Add to ChatGPT Developer Mode                                       ║
╚═══════════════════════════════════════════════════════════════════════════╝
  `.trim());
});
