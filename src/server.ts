#!/usr/bin/env node

/**
 * MCP HTTP Server with OAuth support
 * Exposes a local Streamable HTTP MCP server that proxies to a remote HTTP MCP server,
 * handling OAuth 2.1 authentication transparently.
 *
 * Run with: npx tsx server.ts https://example.remote/server [--listen-port 3333] [callback-port] [--debug]
 */

import { EventEmitter } from 'events'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import express from 'express'
import { randomUUID } from 'crypto'
import {
  connectToRemoteServer,
  log,
  debugLog,
  mcpProxy,
  parseCommandLineArgs,
  setupSignalHandlers,
  TransportStrategy,
  discoverOAuthServerInfo,
} from './lib/utils'
import { StaticOAuthClientInformationFull, StaticOAuthClientMetadata } from './lib/types'
import { NodeOAuthClientProvider } from './lib/node-oauth-client-provider'
import { createLazyAuthCoordinator } from './lib/coordination'

const DEFAULT_LISTEN_PORT = 3333

type Session = {
  localTransport: StreamableHTTPServerTransport
  remoteTransport: Transport
}

/**
 * Main function to run the HTTP server proxy
 */
async function runServer(
  serverUrl: string,
  listenPort: number,
  callbackPort: number,
  headers: Record<string, string>,
  transportStrategy: TransportStrategy = 'http-first',
  host: string,
  staticOAuthClientMetadata: StaticOAuthClientMetadata,
  staticOAuthClientInfo: StaticOAuthClientInformationFull,
  authorizeResource: string,
  ignoredTools: string[],
  authTimeoutMs: number,
  serverUrlHash: string,
) {
  // Set up event emitter for auth flow
  const events = new EventEmitter()

  // Create a lazy auth coordinator
  const authCoordinator = createLazyAuthCoordinator(serverUrlHash, callbackPort, events, authTimeoutMs)

  // Discover OAuth server info via Protected Resource Metadata (RFC 9728)
  log('Discovering OAuth server configuration...')
  const discoveryResult = await discoverOAuthServerInfo(serverUrl, headers)

  if (discoveryResult.protectedResourceMetadata) {
    log(`Discovered authorization server: ${discoveryResult.authorizationServerUrl}`)
    if (discoveryResult.protectedResourceMetadata.scopes_supported) {
      debugLog('Protected Resource Metadata scopes', {
        scopes_supported: discoveryResult.protectedResourceMetadata.scopes_supported,
      })
    }
  } else {
    debugLog('No Protected Resource Metadata found, using server URL as authorization server')
  }

  // Create the OAuth client provider with discovered server info
  const authProvider = new NodeOAuthClientProvider({
    serverUrl: discoveryResult.authorizationServerUrl,
    callbackPort,
    host,
    clientName: 'MCP HTTP Proxy',
    staticOAuthClientMetadata,
    staticOAuthClientInfo,
    authorizeResource,
    serverUrlHash,
    authorizationServerMetadata: discoveryResult.authorizationServerMetadata,
    protectedResourceMetadata: discoveryResult.protectedResourceMetadata,
    wwwAuthenticateScope: discoveryResult.wwwAuthenticateScope,
  })

  // OAuth callback server reference for cleanup
  let oauthServer: any = null

  // Define an auth initializer function (shared across all sessions)
  const authInitializer = async () => {
    const authState = await authCoordinator.initializeAuth()

    // Store server in outer scope for cleanup
    oauthServer = authState.server

    if (authState.skipBrowserAuth) {
      log('Authentication was completed by another instance - will use tokens from disk')
      await new Promise((res) => setTimeout(res, 1_000))
    }

    return {
      waitForAuthCode: authState.waitForAuthCode,
      skipBrowserAuth: authState.skipBrowserAuth,
    }
  }

  // Track all active sessions
  const sessions = new Map<string, Session>()

  // Create Express app
  const app = express()
  app.use(express.json())

  app.all('/mcp', async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined

    // Route existing sessions to their transport
    if (sessionId && sessions.has(sessionId)) {
      debugLog(`Routing request to existing session: ${sessionId}`)
      await sessions.get(sessionId)!.localTransport.handleRequest(req, res, req.body)
      return
    }

    // Reject requests with unknown session IDs
    if (sessionId) {
      log(`Unknown session ID: ${sessionId}`)
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // New session: establish upstream connection first
    debugLog('Creating new session and upstream connection')
    let remoteTransport: Transport
    try {
      remoteTransport = await connectToRemoteServer(null, serverUrl, authProvider, headers, authInitializer, transportStrategy)
    } catch (error) {
      log('Failed to connect to upstream server:', error)
      res.status(503).json({ error: 'Failed to connect to upstream MCP server' })
      return
    }

    let assignedSessionId: string | undefined
    const localTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        assignedSessionId = id
        sessions.set(id, { localTransport, remoteTransport })
        log(`New session established: ${id}`)
      },
      onsessionclosed: (id) => {
        debugLog(`Session explicitly closed by client: ${id}`)
        sessions.delete(id)
        remoteTransport.close().catch((e) => debugLog(`Error closing remote transport: ${e}`))
      },
    })

    // Handle transport-level close (e.g., connection dropped)
    localTransport.onclose = () => {
      if (assignedSessionId && sessions.has(assignedSessionId)) {
        debugLog(`Transport closed for session: ${assignedSessionId}`)
        sessions.delete(assignedSessionId)
        remoteTransport.close().catch((e) => debugLog(`Error closing remote transport: ${e}`))
      }
    }

    // Wire up bidirectional proxy between local and remote transports
    mcpProxy({
      transportToClient: localTransport,
      transportToServer: remoteTransport,
      ignoredTools,
    })

    await localTransport.handleRequest(req, res, req.body)
  })

  // Start the HTTP server bound to localhost only
  const httpServer = app.listen(listenPort, '127.0.0.1', () => {
    log(`HTTP MCP server listening at http://127.0.0.1:${listenPort}/mcp`)
    log('Press Ctrl+C to exit')
  })

  // Setup cleanup handler
  const cleanup = async () => {
    for (const { localTransport, remoteTransport } of sessions.values()) {
      await localTransport.close().catch(() => {})
      await remoteTransport.close().catch(() => {})
    }
    sessions.clear()
    if (oauthServer) {
      oauthServer.close()
    }
    httpServer.close()
  }

  setupSignalHandlers(cleanup)
}

// Parse --listen-port before handing off to parseCommandLineArgs
const rawArgs = process.argv.slice(2)
let listenPort = DEFAULT_LISTEN_PORT
const listenPortIndex = rawArgs.indexOf('--listen-port')
if (listenPortIndex !== -1 && listenPortIndex < rawArgs.length - 1) {
  const parsed = parseInt(rawArgs[listenPortIndex + 1], 10)
  if (!isNaN(parsed) && parsed > 0) {
    listenPort = parsed
  }
  rawArgs.splice(listenPortIndex, 2)
}

parseCommandLineArgs(rawArgs, 'Usage: npx tsx server.ts <https://server-url> [callback-port] [--listen-port 3333] [--debug]')
  .then(
    ({
      serverUrl,
      callbackPort,
      headers,
      transportStrategy,
      host,
      staticOAuthClientMetadata,
      staticOAuthClientInfo,
      authorizeResource,
      ignoredTools,
      authTimeoutMs,
      serverUrlHash,
    }) => {
      return runServer(
        serverUrl,
        listenPort,
        callbackPort,
        headers,
        transportStrategy,
        host,
        staticOAuthClientMetadata,
        staticOAuthClientInfo,
        authorizeResource,
        ignoredTools,
        authTimeoutMs,
        serverUrlHash,
      )
    },
  )
  .catch((error) => {
    log('Fatal error:', error)
    process.exit(1)
  })
