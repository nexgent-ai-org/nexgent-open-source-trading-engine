/**
 * Redis Key Constants and Helpers
 * 
 * Centralized management for Redis keys to ensuring consistency and type safety.
 */

export const REDIS_KEYS = {
  // Position related keys
  POSITION: (id: string) => `position:${id}`,
  AGENT_POSITIONS: (agentId: string) => `agent:${agentId}:positions`,
  TOKEN_POSITIONS: (tokenAddress: string) => `token:${tokenAddress}:positions`,
  
  // Balance related keys
  BALANCE: (agentId: string, walletAddress: string, tokenAddress: string) => `balance:${agentId}:${walletAddress}:${tokenAddress}`,
  
  // Config related keys
  AGENT_CONFIG: (agentId: string) => `config:${agentId}`,
  
  // Agent related keys
  ACTIVE_AGENTS: 'active_agents',
  AGENT_TRADING_MODE: (agentId: string) => `agent:${agentId}:trading_mode`,
  AGENT_AUTOMATED_TRADING: (agentId: string, mode: 'simulation' | 'live') => `agent:${agentId}:automated_trading:${mode}`,
  
  // Price related keys
  // Token addresses are normalized to lowercase so a caller's casing cannot
  // split one token across two cache entries. Writers use the normalized
  // address while some readers pass the original mixed-case mint, which
  // previously meant those reads always missed.
  PRICE: (tokenAddress: string) => `price:${tokenAddress.toLowerCase()}`,
  
  // Signal related keys
  SIGNAL: (signalId: string) => `signal:${signalId}`,
  SIGNAL_EXECUTIONS: (signalId: string) => `signal:${signalId}:executions`,
  
  // Lock related keys
  LOCK: (resource: string) => `lock:${resource}`,
  
  // Idempotency related keys
  IDEMPOTENCY: (operation: string) => `idempotency:${operation}`,

  /** Dedupe signal creation: userId + token + signalType + signalStrength within a short window */
  SIGNAL_CREATION_DEDUPE: (userId: string, tokenAddress: string, signalType: string, signalStrength: number) =>
    `signal_create:${userId}:${tokenAddress}:${signalType}:${signalStrength}`,
};

// Time-to-live constants (in seconds)
// Note: CONFIG, POSITION, BALANCE, PRICE, and SIGNAL use write-through cache pattern
// They are invalidated explicitly when DB changes or refreshed constantly, so they don't need TTL
export const REDIS_TTL = {
  PRICE: undefined,   // No TTL - prices are refreshed every 1.5s when positions exist, last known price should persist during gaps
  CONFIG: undefined,  // No TTL - invalidated explicitly via write-through pattern
  POSITION: undefined, // No TTL - invalidated explicitly via write-through pattern
  BALANCE: undefined, // No TTL - invalidated explicitly via write-through pattern
  SIGNAL: undefined,  // No TTL - invalidated explicitly when needed
  LOCK: 10,           // 10 seconds for locks (should be short, operations should be fast)
  IDEMPOTENCY: 300,   // 5 minutes for idempotency keys (temporary operation markers)
  SIGNAL_CREATION_DEDUPE: 60,  // 60 seconds - reject duplicate signals for same token+type+strength
};

