import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  McpServer,
  createMcpHandler,
  fromJsonSchema,
  type AuthInfo,
  type CallToolResult,
  type McpRequestContext
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { CallerEvidence, JsonObject, OctopusBroker } from '../core/index.js';
import {
  MCP_TOOL_CATALOG,
  MCP_CONTRACT_VERSION,
  mcpToolInputJsonSchemas,
  mcpToolOutputJsonSchemas,
  parseMcpToolInput,
  parseMcpToolOutput,
  type McpAsyncToolName,
  type McpToolName
} from '../../../shared/protocol/src/index.js';
import type { RelayRepositories } from '../storage/index.js';
import { authenticateRequest, rejectUnauthorized } from './auth.js';
import { callerEvidenceFromContext } from './caller-evidence.js';

type NodeRequestWithAuth = IncomingMessage & { auth?: AuthInfo };

interface PendingAcknowledgement {
  requestRef: string;
}

interface DeliveryContext {
  acknowledgements: PendingAcknowledgement[];
}

export interface McpGatewayOptions {
  host: string;
  port: number;
  serviceVersion: string;
  health: () => Record<string, unknown>;
  onError?: (error: Error) => void;
}

/**
 * HTTP MCP adapter for the canonical fourteen-tool contract.
 *
 * Async ticket acknowledgement is separated from tool construction. A handler
 * only queues its request_ref in request-local storage. The outer Node response
 * marks the acknowledgement delivered after `finish`, which is the closest
 * signal available here that the SDK handed the complete response to the local
 * transport. A premature connection close marks delivery failed instead. This
 * deliberately prevents broker dispatch from happening synchronously inside
 * the tool handler that creates the accepted response.
 */
export class McpGateway {
  private readonly httpServer: Server;
  private readonly delivery = new AsyncLocalStorage<DeliveryContext>();

  constructor(
    private readonly broker: OctopusBroker,
    private readonly store: RelayRepositories,
    private readonly options: McpGatewayOptions
  ) {
    const mcpHandler = createMcpHandler((context) => this.createMcpServer(context), {
      legacy: 'stateless',
      responseMode: 'json',
      onerror: (error) => this.reportError(error)
    });
    const nodeHandler = toNodeHandler(mcpHandler, {
      onerror: (error) => this.reportError(error)
    });
    this.httpServer = createServer(async (request, response) => {
      if (!this.allowedHost(request.headers.host)) {
        response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'FORBIDDEN_HOST' }));
        return;
      }
      if (request.url === '/health' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok', ...this.options.health() }));
        return;
      }
      if (request.url !== '/mcp') {
        response.writeHead(404).end();
        return;
      }
      const auth = authenticateRequest(request, this.store);
      if (!auth) {
        rejectUnauthorized(response);
        return;
      }
      if (request.headers['x-octopus-contract-version'] !== MCP_CONTRACT_VERSION) {
        response.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({
          error: 'MCP_CONTRACT_VERSION_MISMATCH', expected: MCP_CONTRACT_VERSION
        }));
        return;
      }
      (request as NodeRequestWithAuth).auth = auth;
      const deliveryContext: DeliveryContext = { acknowledgements: [] };
      try {
        await this.delivery.run(deliveryContext, async () => nodeHandler(
          request as unknown as Parameters<typeof nodeHandler>[0],
          response as unknown as Parameters<typeof nodeHandler>[1]
        ));
        this.confirmAfterResponseHandoff(response, deliveryContext.acknowledgements);
      } catch (error) {
        this.confirmAll(deliveryContext.acknowledgements, false);
        this.reportError(error instanceof Error ? error : new Error('Unknown MCP request failure.'));
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'MCP_REQUEST_FAILED' }));
        } else if (!response.writableEnded) {
          response.destroy();
        }
      }
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.options.port, this.options.host, () => {
        this.httpServer.off('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.httpServer.close((error) => error ? reject(error) : resolve()));
  }

  address(): { host: string; port: number } {
    const address = this.httpServer.address();
    if (!address || typeof address === 'string') return { host: this.options.host, port: this.options.port };
    return { host: address.address, port: address.port };
  }

  private createMcpServer(context: McpRequestContext): McpServer {
    const authInfo = this.requireAuth(context.authInfo);
    const evidence = callerEvidenceFromContext(context, authInfo);
    const server = new McpServer({
      name: 'tabro',
      version: this.options.serviceVersion
    });

    for (const definition of MCP_TOOL_CATALOG) {
      const inputSchema = fromJsonSchema(mcpToolInputJsonSchemas[definition.name]);
      const outputSchema = fromJsonSchema(mcpToolOutputJsonSchemas[definition.name]);
      server.registerTool(definition.name, {
        title: this.title(definition.name),
        description: definition.description,
        inputSchema,
        outputSchema
      }, async (rawInput) => this.handleTool(definition.name, rawInput, evidence));
    }

    return server;
  }

  private async handleTool(tool: McpToolName, rawInput: unknown, evidence: CallerEvidence): Promise<CallToolResult> {
    const input = parseMcpToolInput(tool, rawInput);
    let output: unknown;

    if (tool === 'list_browser_profiles') {
      output = await this.broker.listBrowserProfiles(input, evidence);
    } else if (tool === 'get_browser_context') {
      output = await this.broker.getBrowserContext(input, evidence);
    } else if (tool === 'read_cdp_events') {
      output = await this.broker.readCdpEvents(input, evidence);
    } else if (tool === 'get_browser_request') {
      output = await this.broker.getBrowserRequest(input, evidence);
    } else if (tool === 'close_browser_request') {
      output = await this.broker.closeBrowserRequest(input, evidence);
    } else {
      output = await this.broker.submit(tool as McpAsyncToolName, input, evidence);
    }

    const acceptedRequestRef = this.acceptedRequestRef(output);
    try {
      const validated = parseMcpToolOutput(tool, output);
      const structuredContent = this.asObject(validated);
      const result: CallToolResult = {
        content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
        structuredContent
      };
      if (acceptedRequestRef !== null) this.queueAcknowledgement(acceptedRequestRef);
      return result;
    } catch (error) {
      if (acceptedRequestRef !== null) this.broker.confirmAcknowledgement(acceptedRequestRef, false);
      throw error;
    }
  }

  private queueAcknowledgement(requestRef: string): void {
    const context = this.delivery.getStore();
    if (!context) {
      throw new Error('Accepted MCP ticket was constructed outside an HTTP response delivery context.');
    }
    context.acknowledgements.push({ requestRef });
  }

  private confirmAfterResponseHandoff(response: ServerResponse, acknowledgements: PendingAcknowledgement[]): void {
    if (acknowledgements.length === 0) return;
    let settled = false;
    const settle = (delivered: boolean): void => {
      if (settled) return;
      settled = true;
      this.confirmAll(acknowledgements, delivered);
    };
    if (response.writableFinished) {
      settle(true);
      return;
    }
    response.once('finish', () => settle(true));
    response.once('close', () => settle(response.writableFinished));
    response.once('error', () => settle(false));
  }

  private confirmAll(acknowledgements: PendingAcknowledgement[], delivered: boolean): void {
    for (const acknowledgement of acknowledgements) {
      try {
        this.broker.confirmAcknowledgement(acknowledgement.requestRef, delivered);
      } catch (error) {
        this.reportError(error instanceof Error ? error : new Error('Unknown acknowledgement error.'));
      }
    }
  }

  private acceptedRequestRef(output: unknown): string | null {
    if (!this.isObject(output) || output.disposition !== 'accepted') return null;
    if (!this.isObject(output.facts) || !this.isObject(output.facts.ticket)) return null;
    return typeof output.facts.ticket.request_ref === 'string' ? output.facts.ticket.request_ref : null;
  }

  private requireAuth(authInfo: AuthInfo | undefined): AuthInfo {
    if (!authInfo) throw new Error('Authenticated MCP context is required.');
    return authInfo;
  }

  private asObject(value: unknown): Record<string, unknown> {
    if (this.isObject(value)) return value;
    throw new TypeError('Canonical MCP output must be a JSON object.');
  }

  private isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private title(tool: McpToolName): string {
    return tool.split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  }

  private reportError(error: Error): void {
    if (this.options.onError) this.options.onError(error);
    else console.error('MCP gateway error:', error.message);
  }

  private allowedHost(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    const hostname = hostHeader.replace(/^\[/, '').split(']')[0]!.split(':')[0]!.toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  }
}
