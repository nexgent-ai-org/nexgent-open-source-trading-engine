/**
 * WebSocket Server
 * 
 * Handles WebSocket connections for real-time position and price updates.
 * Uses HTTP upgrade on the same port as Express server.
 * One agent per connection.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { IncomingMessage } from 'http';
import { verifyToken } from '@/shared/utils/auth/jwt.js';
import type { JWTPayload } from '@/shared/utils/auth/types.js';
import { positionEventEmitter } from '@/domain/trading/position-events.js';
import { positionService } from '@/domain/trading/position-service.js';
import { priceFeedService } from '../external/dexscreener/index.js';
import { redisPriceService } from '../cache/redis-price-service.js';
import { SolPriceService } from '@/infrastructure/external/jupiter/price/sol-price-service.js';
import { prisma } from '../database/client.js';
import type { OpenPosition } from '@nexgent/shared';
import logger from '../logging/logger.js';

/**
 * WebSocket connection with metadata
 */
interface WSConnection {
  ws: WebSocket;
  userId: string;
  agentId: string;
  connectedAt: Date;
  lastPing: Date;
}

/**
 * WebSocket message types
 */
interface WSMessage {
  type: string;
  data?: unknown;
  timestamp?: string;
}

/**
 * WebSocket Server Manager
 */
class WSServer {
  private wss: WebSocketServer | null = null;
  private connections: Map<string, WSConnection> = new Map(); // agentId -> connection
  private pingInterval: NodeJS.Timeout | null = null;
  private readonly PING_INTERVAL = 30000; // 30 seconds
  private readonly PONG_TIMEOUT = 10000; // 10 seconds

  /**
   * Initialize WebSocket server with HTTP upgrade
   */
  initialize(httpServer: Server): void {
    if (this.wss) {
      console.log('⚠️  WebSocket server already initialized');
      return;
    }

    // Create WebSocket server with HTTP upgrade
    // verifyClient performs JWT authentication *before* the handshake completes,
    // rejecting unauthenticated connections without consuming server resources.
    // Agent-level authorization (DB lookup) still happens in handleConnection.
    this.wss = new WebSocketServer({
      server: httpServer,
      path: '/ws',
      verifyClient: (info: { origin: string; secure: boolean; req: import('http').IncomingMessage }, done: (result: boolean, code?: number, message?: string) => void) => {
        try {
          const url = new URL(info.req.url || '', `http://${info.req.headers.host || 'localhost'}`);
          const token = url.searchParams.get('token');
          const agentId = url.searchParams.get('agentId');

          if (!token || !agentId) {
            done(false, 401, 'Missing token or agentId');
            return;
          }

          // Verify JWT signature and expiration synchronously
          verifyToken(token);

          // Token is valid — allow the upgrade to proceed.
          // Agent ownership is verified in handleConnection after the socket is open.
          done(true);
        } catch (_error) {
          done(false, 401, 'Invalid or expired token');
        }
      },
    });

    // Handle new connections
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    // Set up position event listeners
    this.setupPositionEventListeners();

    // Start ping interval
    this.startPingInterval();

    console.log('✅ WebSocket server initialized on /ws');
  }

  /**
   * Handle new WebSocket connection
   */
  private async handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    try {
      // Extract token and agentId from query params
      const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
      const token = url.searchParams.get('token');
      const agentId = url.searchParams.get('agentId');

      if (!token || !agentId) {
        this.sendError(ws, 'Missing token or agentId');
        ws.close(1008, 'Missing authentication');
        return;
      }

      // Verify JWT token
      let payload: JWTPayload;
      try {
        payload = verifyToken(token);
      } catch (_error) {
        this.sendError(ws, 'Invalid or expired token');
        ws.close(1008, 'Authentication failed');
        return;
      }

      // Validate agent belongs to user
      const agent = await prisma.agent.findFirst({
        where: {
          id: agentId,
          userId: payload.userId,
        },
        select: {
          id: true,
        },
      });

      if (!agent) {
        this.sendError(ws, 'Agent not found or access denied');
        ws.close(1008, 'Agent not found');
        return;
      }

      // Check if connection already exists for this agent (one agent per connection)
      const existingConnection = this.connections.get(agentId);
      if (existingConnection) {
        // Close existing connection
        existingConnection.ws.close(1000, 'New connection established');
        this.connections.delete(agentId);
      }

      // Create connection record
      const connection: WSConnection = {
        ws,
        userId: payload.userId,
        agentId,
        connectedAt: new Date(),
        lastPing: new Date(),
      };

      this.connections.set(agentId, connection);

      // Set up message handlers
      ws.on('message', (data: Buffer) => {
        this.handleMessage(connection, data);
      });

      ws.on('close', (code, reason) => {
        console.log(`[WebSocket] Connection closed for agent ${agentId}: code=${code}, reason=${reason.toString()}`);
        this.handleDisconnection(agentId, ws);
      });

      ws.on('error', (error) => {
        console.error(`[WebSocket] Error for agent ${agentId}:`, error);
        // Don't call handleDisconnection here - let the 'close' event handle cleanup
        // This prevents double cleanup
      });

      // Send connection confirmation
      this.sendMessage(ws, {
        type: 'connected',
        data: {
          agentId,
          timestamp: new Date().toISOString(),
        },
      });

      // Send initial data
      await this.sendInitialData(ws, agentId);

      console.log(`✅ WebSocket connected: agent ${agentId}, user ${payload.userId}`);
    } catch (error) {
      console.error('WebSocket connection error:', error);
      this.sendError(ws, 'Connection failed');
      ws.close(1011, 'Internal server error');
    }
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(connection: WSConnection, data: Buffer): void {
    try {
      const message: WSMessage = JSON.parse(data.toString());

      switch (message.type) {
        case 'ping':
          // Client sent ping (shouldn't happen, but handle it)
          // Respond to ping with pong
          this.sendMessage(connection.ws, {
            type: 'pong',
            timestamp: new Date().toISOString(),
          });
          connection.lastPing = new Date();
          break;

        case 'pong':
          // Client responded to our ping - update lastPing to indicate connection is alive
          connection.lastPing = new Date();
          // Pong is too frequent to log
          break;

        case 'subscribe':
          // Already subscribed on connection, just acknowledge
          this.sendMessage(connection.ws, {
            type: 'subscribed',
            data: {
              agentId: connection.agentId,
            },
          });
          break;

        default:
          console.warn(`Unknown message type: ${message.type}`);
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
      this.sendError(connection.ws, 'Invalid message format');
    }
  }

  /**
   * Handle WebSocket disconnection.
   * Only removes the connection from the map if the disconnecting socket is still
   * the one stored — prevents a stale close event from an old socket from removing
   * a newer replacement connection for the same agent.
   */
  private handleDisconnection(agentId: string, ws: WebSocket): void {
    const current = this.connections.get(agentId);
    if (current && current.ws === ws) {
      this.connections.delete(agentId);
      console.log(`🔌 WebSocket disconnected: agent ${agentId}`);
    }
  }

  /**
   * Send initial data to client on connection
   * Enriches positions with current prices and P/L calculations (same as API endpoint)
   * 
   * OPTIMIZED: Batch fetches all prices in a single API call instead of sequential calls
   */
  private async sendInitialData(ws: WebSocket, agentId: string): Promise<void> {
    const startTime = Date.now();
    
    try {
      // Get all wallets for this agent
      const wallets = await prisma.agentWallet.findMany({
        where: {
          agentId,
        },
        select: {
          walletAddress: true,
        },
      });

      // Step 1: Load all positions from all wallets first
      const allPositions: Array<OpenPosition & { walletAddress: string }> = [];
      
      for (const wallet of wallets) {
        try {
          const positions = await positionService.loadPositions(agentId, wallet.walletAddress);
          for (const position of positions) {
            if (position.purchaseTransactionId) {
              allPositions.push({ ...position, walletAddress: wallet.walletAddress });
            } else {
              console.warn(`[WebSocket] Position ${position.id} missing purchaseTransactionId, skipping`);
            }
          }
        } catch (walletError) {
          console.error(`[WebSocket] Error loading positions for wallet ${wallet.walletAddress}:`, walletError);
        }
      }

      // Step 2: Get prices - first from Redis cache, fallback to API for misses
      const tokenAddresses = [...new Set(allPositions.map(p => p.tokenAddress.toLowerCase()))];
      const priceMap = new Map<string, { priceSol: number; priceUsd: number }>();
      
      if (tokenAddresses.length > 0) {
        // First, try to get all prices from Redis cache (FAST - no network call)
        const cachedPrices = await redisPriceService.getMultiplePrices(tokenAddresses);
        const missingTokens: string[] = [];
        
        for (const [address, cached] of cachedPrices.entries()) {
          if (cached && cached.priceSol > 0) {
            priceMap.set(address.toLowerCase(), {
              priceSol: cached.priceSol,
              priceUsd: cached.priceUsd || 0,
            });
          } else {
            missingTokens.push(address);
          }
        }
        
        const cacheHits = tokenAddresses.length - missingTokens.length;
        logger.debug({ cacheHits, total: tokenAddresses.length }, 'WS Redis price cache check');
        
        // Only call Jupiter API for tokens not in cache (should be rare after warmup)
        if (missingTokens.length > 0) {
          try {
            logger.debug({ count: missingTokens.length }, 'WS fetching missing prices');
            const prices = await priceFeedService.getMultipleTokenPrices(missingTokens);
            for (const price of prices) {
              priceMap.set(price.tokenAddress.toLowerCase(), {
                priceSol: price.priceSol,
                priceUsd: price.priceUsd || 0,
              });
            }
            logger.debug({ fetched: prices.length }, 'WS prices fetched');
          } catch (priceError) {
            logger.warn({ error: priceError }, 'WS failed to fetch prices');
          }
        }
      }

      // Step 3: Enrich all positions with prices (no more sequential API calls!)
      // Display path: use the last known price if we have one. A null here means
      // no price has ever been obtained, in which case USD values are left at 0
      // rather than computed from a placeholder rate.
      const solPrice = SolPriceService.getInstance().getSolPrice() ?? 0;
      const enrichedPositions = [];

      for (const position of allPositions) {
        try {
          const tokenAddressLower = position.tokenAddress.toLowerCase();
          const priceData = priceMap.get(tokenAddressLower);
          
          // Use fetched price or fallback to purchase price
          const currentPrice = priceData?.priceSol ?? position.purchasePrice ?? 0;
          const currentPriceUsd = priceData?.priceUsd ?? ((position.purchasePrice ?? 0) * solPrice);
          
          // Validate numeric values
          const purchasePrice = position.purchasePrice || 0;
          const purchaseAmount = position.purchaseAmount || 0;
          // Use remainingAmount for P/L calculations if take-profit has occurred
          const currentHolding = position.remainingAmount ?? purchaseAmount;
          // Realized profit from take-profit sales (already locked in)
          const realizedProfitSol = position.realizedProfitSol ?? 0;

          // Calculate values
          const priceChangePercent = purchasePrice > 0
            ? ((currentPrice - purchasePrice) / purchasePrice) * 100
            : 0;
          const purchasePriceUsd = purchasePrice * solPrice;
          // Position value is based on what's CURRENTLY held (after any take-profit sales)
          const positionValueSol = currentPrice * currentHolding;
          const positionValueUsd = currentPriceUsd * currentHolding;
          // Unrealized P/L is based on current holding
          const unrealizedProfitSol = positionValueSol - (purchasePrice * currentHolding);
          const unrealizedProfitUsd = unrealizedProfitSol * solPrice;
          // Total P/L = Realized (from take-profit) + Unrealized (on remaining tokens)
          const profitLossSol = realizedProfitSol + unrealizedProfitSol;
          const profitLossUsd = (realizedProfitSol * solPrice) + unrealizedProfitUsd;
          
          // Cost basis is based on ORIGINAL purchase for accurate total % calculation
          const originalCostBasis = purchasePriceUsd * purchaseAmount;
          const profitLossPercent = originalCostBasis > 0
            ? (profitLossUsd / originalCostBasis) * 100
            : 0;

          enrichedPositions.push({
            id: position.id,
            agentId: position.agentId,
            walletAddress: position.walletAddress,
            tokenAddress: position.tokenAddress,
            tokenSymbol: position.tokenSymbol,
            purchasePrice,
            purchaseAmount,
            currentPrice,
            currentPriceUsd,
            purchasePriceUsd,
            positionValueUsd,
            positionValueSol,
            profitLossUsd,
            profitLossSol,
            profitLossPercent,
            priceChangePercent,
            currentStopLossPercentage: position.currentStopLossPercentage,
            peakPrice: position.peakPrice,
            // DCA fields
            totalInvestedSol: position.totalInvestedSol,
            dcaCount: position.dcaCount,
            lastDcaTime: position.lastDcaTime,
            lowestPrice: position.lowestPrice,
            dcaTransactionIds: position.dcaTransactionIds,
            lastStopLossUpdate: position.lastStopLossUpdate,
            // Take-profit fields
            remainingAmount: position.remainingAmount,
            takeProfitLevelsHit: position.takeProfitLevelsHit ?? 0,
            takeProfitTransactionIds: position.takeProfitTransactionIds ?? [],
            lastTakeProfitTime: position.lastTakeProfitTime,
            moonBagActivated: position.moonBagActivated ?? false,
            moonBagAmount: position.moonBagAmount,
            realizedProfitSol: position.realizedProfitSol ?? 0,
            tpBatchStartLevel: position.tpBatchStartLevel ?? 0,
            totalTakeProfitLevels: position.totalTakeProfitLevels ?? null,
            createdAt: position.createdAt,
            updatedAt: position.updatedAt,
            purchaseTransactionId: position.purchaseTransactionId,
          });
        } catch (posError) {
          console.error(`[WebSocket] Error processing position ${position?.id || 'unknown'}:`, posError);
        }
      }

      // Send initial data
      const totalTime = Date.now() - startTime;
      logger.debug({ agentId, positions: enrichedPositions.length, time: totalTime }, 'WS initial data sent');
      
      this.sendMessage(ws, {
        type: 'initial_data',
        data: {
          positions: enrichedPositions,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.error('[WebSocket] Error sending initial data:', error);
      if (error instanceof Error) {
        console.error('[WebSocket] Error message:', error.message);
        console.error('[WebSocket] Error stack:', error.stack);
      }
      this.sendError(ws, `Failed to load initial data: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Set up position event listeners
   */
  private setupPositionEventListeners(): void {
    // Listen for position created events
    positionEventEmitter.on('position_created', (event) => {
      // Only attempt to broadcast if agent has an active connection
      if (this.isAgentConnected(event.agentId)) {
        this.broadcastToAgent(event.agentId, {
          type: 'position_update',
          data: {
            eventType: 'position_created',
            position: event.position,
          },
        });
      }
    });

    // Listen for position updated events
    positionEventEmitter.on('position_updated', (event) => {
      // Only attempt to broadcast if agent has an active connection
      if (this.isAgentConnected(event.agentId)) {
        this.broadcastToAgent(event.agentId, {
          type: 'position_update',
          data: {
            eventType: 'position_updated',
            position: event.position,
          },
        });
      }
    });

    // Listen for position closed events
    positionEventEmitter.on('position_closed', (event) => {
      // Only attempt to broadcast if agent has an active connection
      if (this.isAgentConnected(event.agentId)) {
        this.broadcastToAgent(event.agentId, {
          type: 'position_update',
          data: {
            eventType: 'position_closed',
            positionId: event.positionId,
          },
        });
      }
    });
  }

  /**
   * Broadcast message to specific agent's connection
   */
  private broadcastToAgent(agentId: string, message: WSMessage): void {
    const connection = this.connections.get(agentId);
    if (connection && connection.ws.readyState === WebSocket.OPEN) {
      this.sendMessage(connection.ws, message);
      if (message.type === 'position_update') {
        const data = message.data as { eventType?: string; position?: { id?: string }; positionId?: string };
        logger.debug({ agentId, eventType: data.eventType, positionId: data.position?.id ?? data.positionId }, 'WS position update sent');
      }
      // Don't log every message - too noisy
    } else {
      console.warn(`[WebSocket] Cannot send message to agent ${agentId}: ${connection ? 'connection not open' : 'no connection'}`);
    }
  }

  /**
   * Broadcast batch price updates to agent
   * 
   * @param agentId - Agent ID to broadcast to
   * @param updates - Array of price updates
   */
  broadcastPriceUpdates(agentId: string, updates: Array<{ tokenAddress: string; price: number; priceUsd: number }>): void {
    // Only attempt to broadcast if agent has an active connection
    if (!this.isAgentConnected(agentId)) {
      // Silently skip - no need to log warnings for agents without connections
      // This is expected when frontend is not connected
      return;
    }

    // Price update broadcasts are too frequent to log
    this.broadcastToAgent(agentId, {
      type: 'price_update_batch',
      data: {
        updates,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * Broadcast price update to agent
   * 
   * @param agentId - Agent ID to broadcast to
   * @param tokenAddress - Token address
   * @param price - Price in SOL
   * @param priceUsd - Price in USD
   */
  broadcastPriceUpdate(agentId: string, tokenAddress: string, price: number, priceUsd: number): void {
    this.broadcastPriceUpdates(agentId, [{ tokenAddress, price, priceUsd }]);
  }

  /**
   * Get all agent IDs with active connections
   */
  getConnectedAgentIds(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Check if agent has active connection
   */
  isAgentConnected(agentId: string): boolean {
    const connection = this.connections.get(agentId);
    return connection !== undefined && connection.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Send message to WebSocket client
   */
  private sendMessage(ws: WebSocket, message: WSMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        console.error('[WebSocket] Error sending message:', error);
        // If send fails, the connection is likely broken - let the error handler deal with it
        throw error;
      }
    } else {
      console.warn(`[WebSocket] Cannot send message: connection not open (state: ${ws.readyState})`);
    }
  }

  /**
   * Send error message to WebSocket client
   */
  private sendError(ws: WebSocket, error: string): void {
    this.sendMessage(ws, {
      type: 'error',
      data: {
        message: error,
      },
    });
  }

  /**
   * Start ping interval to keep connections alive
   */
  private startPingInterval(): void {
    if (this.pingInterval) {
      return;
    }

    this.pingInterval = setInterval(() => {
      const now = new Date();
      const connectionsToClose: string[] = [];

      for (const [agentId, connection] of this.connections.entries()) {
        // Check if connection is still alive
        if (connection.ws.readyState === WebSocket.OPEN) {
          // Check for stale connections (no pong response in timeout period)
          const timeSinceLastPong = now.getTime() - connection.lastPing.getTime();
          
          // Only close if we haven't received a pong in more than 2 ping intervals (60 seconds)
          // This gives the client plenty of time to respond
          if (timeSinceLastPong > this.PING_INTERVAL * 2) {
            // Connection is stale (no pong response), close it
            console.warn(`[WebSocket] Connection timeout for agent ${agentId} (no pong in ${timeSinceLastPong}ms)`);
            connectionsToClose.push(agentId);
          } else {
            // Send ping to keep connection alive
            try {
              this.sendMessage(connection.ws, {
                type: 'ping',
                timestamp: now.toISOString(),
              });
              // Don't update lastPing here - only update when we receive pong
              // This way we can detect if client stops responding
            } catch (error) {
              console.error(`[WebSocket] Error sending ping to agent ${agentId}:`, error);
              connectionsToClose.push(agentId);
            }
          }
        } else {
          // Connection is not open, remove it
          connectionsToClose.push(agentId);
        }
      }

      // Close stale connections
      for (const agentId of connectionsToClose) {
        const connection = this.connections.get(agentId);
        if (connection) {
          try {
            connection.ws.close(1000, 'Connection timeout');
          } catch (error) {
            console.error(`[WebSocket] Error closing connection for agent ${agentId}:`, error);
          }
        }
        this.connections.delete(agentId);
      }
    }, this.PING_INTERVAL);
  }

  /**
   * Shutdown WebSocket server
   */
  shutdown(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    // Close all connections
    for (const connection of this.connections.values()) {
      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.close(1000, 'Server shutdown');
      }
    }

    this.connections.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    console.log('✅ WebSocket server shut down');
  }

  /**
   * Get WebSocket server health status
   */
  getHealthStatus(): { status: 'healthy' | 'unhealthy'; connectionCount?: number } {
    if (!this.wss) {
      return { status: 'unhealthy' };
    }

    const connectionCount = this.connections.size;
    return {
      status: 'healthy',
      connectionCount,
    };
  }
}

// Export singleton instance
export const wsServer = new WSServer();
