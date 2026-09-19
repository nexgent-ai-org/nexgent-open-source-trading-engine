/**
 * Jupiter Swap Provider
 * 
 * Implementation of swap provider using Jupiter Aggregator API
 */

import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { BaseSwapProvider } from './base-swap-provider.js';
import type { SwapQuoteRequest, SwapQuote, SwapExecuteRequest, SwapResult } from './types.js';
import { SwapServiceError } from './types.js';
import { walletStore } from '@/infrastructure/wallets/index.js';
import logger from '@/infrastructure/logging/logger.js';

/**
 * Jupiter API base URL
 */
const JUPITER_API_BASE_URL = 'https://api.jup.ag/ultra';

/**
 * Track if we've warned about missing API key (to avoid spam)
 */
let apiKeyWarningShown = false;

/**
 * Get Jupiter API key from environment
 */
function getJupiterApiKey(): string | undefined {
  const apiKey = process.env.JUPITER_API_KEY;

  // Debug: Log API key status (helpful for troubleshooting)
  if (!apiKey && !apiKeyWarningShown) {
    console.warn('⚠️  JUPITER_API_KEY environment variable is not set. Jupiter API requests will fail.');
    console.warn('   Make sure the key is in packages/backend/.env and the server was restarted.');
    console.warn('   Available env vars:', Object.keys(process.env).filter(k => k.includes('JUPITER')).join(', ') || 'none');
    apiKeyWarningShown = true;
  }

  return apiKey;
}

/**
 * SOL token mint address
 */
export const SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112';

/**
 * Jupiter API quote response structure
 * Based on: https://hub.jup.ag/docs/ultra-api/get-order
 */
interface JupiterQuoteResponse {
  mode?: string;
  swapType?: string;
  router?: string;
  requestId: string;
  transaction?: string; // May be missing if taker is not provided or if there's an error
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  swapMode?: string;
  slippageBps: number;
  priceImpactPct?: string | number;
  priceImpact?: string | number;
  routePlan?: unknown[];
  inputMint?: string;
  outputMint?: string;
  feeMint?: string;
  feeBps?: number;
  taker?: string;
  gasless?: boolean;
  prioritizationFeeLamports?: number;
  inUsdValue?: number;
  outUsdValue?: number;
  swapUsdValue?: number;
  totalTime?: number;
  errorCode?: number; // Present when there's an error
  errorMessage?: string; // Present when there's an error
  error?: string; // Alternative error field
  [key: string]: unknown; // Allow for additional fields
}

/**
 * Jupiter API execute response structure
 * Based on: https://dev.jup.ag/api-reference/ultra/execute
 */
interface JupiterExecuteResponse {
  status: 'Success' | 'Failed';
  code: number;
  signature?: string;           // Transaction signature (hash)
  slot?: string;                // Solana slot number
  error?: string;               // Error message if failed
  totalInputAmount?: string;    // Total input amount
  totalOutputAmount?: string;   // Total output amount
  inputAmountResult?: string;   // Actual input amount result
  outputAmountResult?: string;  // Actual output amount result
  swapEvents?: Array<{
    inputMint: string;
    inputAmount: string;
    outputMint: string;
    outputAmount: string;
  }>;
}

/**
 * Jupiter Swap Provider
 * 
 * Implements swap functionality using Jupiter Aggregator API
 */
export class JupiterSwapProvider extends BaseSwapProvider {
  /**
   * Get the name of the provider
   */
  getName(): string {
    return 'jupiter';
  }

  /**
   * Get a quote for a swap from Jupiter API
   * 
   * @param request - Swap quote request
   * @returns Swap quote with expected output and transaction data
   * @throws SwapServiceError if quote fails
   */
  async getQuote(request: SwapQuoteRequest): Promise<SwapQuote> {
    this.validateQuoteRequest(request);

    const url = new URL(`${JUPITER_API_BASE_URL}/v1/order`);
    url.searchParams.set('inputMint', request.inputMint);
    url.searchParams.set('outputMint', request.outputMint);
    url.searchParams.set('amount', request.amount.toString());
    // Reduce pathological routes through illiquid intermediary tokens/pools.
    // This improves quote safety for thin or manipulated markets.
    url.searchParams.set('restrictIntermediateTokens', 'true');

    if (request.walletAddress) {
      url.searchParams.set('taker', request.walletAddress);
    }

    try {
      const apiKey = getJupiterApiKey();

      // API key is required for api.jup.ag endpoint
      if (!apiKey) {
        throw new SwapServiceError(
          'Jupiter API key is required. Please set JUPITER_API_KEY environment variable.',
          'API_KEY_MISSING',
          {
            endpoint: url.toString(),
            message: 'Generate a key at the Jupiter developer portal and set JUPITER_API_KEY.',
          }
        );
      }

      const response = await this.executeWithRetry(async () => {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };

        // API key is required - Jupiter API uses lowercase 'x-api-key' header
        headers['x-api-key'] = apiKey;

        const res = await fetch(url.toString(), {
          method: 'GET',
          headers,
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => 'Unknown error');

          // Log more details for 401 errors to help debug
          if (res.status === 401) {
            console.error('Jupiter API 401 Unauthorized:', {
              url: url.toString(),
              hasApiKey: !!apiKey,
              apiKeyLength: apiKey?.length || 0,
              apiKeyPrefix: apiKey ? `${apiKey.substring(0, 4)}...` : 'none',
              errorResponse: errorText,
            });

            // If Bearer token doesn't work, the API key format might be wrong
            // Check if the error message gives us clues
            try {
              const errorJson = JSON.parse(errorText);
              console.error('Error details:', errorJson);
            } catch {
              // Not JSON, that's fine
            }
          }

          const error = new Error(`Jupiter API error: ${res.status} ${res.statusText} - ${errorText}`) as Error & { status: number };
          error.status = res.status;
          throw error;
        }

        return res;
      });

      const data = (await response.json()) as JupiterQuoteResponse;

      // Check for errors in the response (Jupiter returns errorCode/errorMessage even with 200 status)
      if (data.errorCode !== undefined && data.errorCode !== 0) {
        const errorMsg = data.errorMessage || data.error || 'Unknown error';
        // Log at debug level - these are expected errors (e.g., insufficient funds)
        logger.debug({
          errorCode: data.errorCode,
          errorMessage: errorMsg,
          requestId: data.requestId,
        }, 'Jupiter API returned error');
        throw new SwapServiceError(
          `Jupiter API error: ${errorMsg}`,
          'JUPITER_API_ERROR',
          {
            errorCode: data.errorCode,
            errorMessage: errorMsg,
            requestId: data.requestId,
          }
        );
      }

      // Validate response has required fields
      if (!data.requestId) {
        logger.debug({ response: data }, 'Invalid Jupiter API response: missing requestId');
        throw new SwapServiceError(
          'Invalid Jupiter API response: missing requestId',
          'INVALID_RESPONSE',
          { response: data }
        );
      }

      // Transaction is optional - only present if taker wallet address is provided
      // However, if taker is provided and transaction is missing, it usually indicates an error
      if (!data.transaction && request.walletAddress) {
        // Check if this is an error case (errorCode would have been caught above, but double-check)
        if (data.errorCode !== undefined || data.errorMessage || data.error) {
          const errorMsg = data.errorMessage || data.error || 'Transaction generation failed';
          throw new SwapServiceError(
            `Jupiter API error: ${errorMsg}`,
            'JUPITER_API_ERROR',
            {
              errorCode: data.errorCode,
              errorMessage: errorMsg,
              requestId: data.requestId,
            }
          );
        }
        logger.debug({ requestId: data.requestId }, 'Jupiter response missing transaction field');
      }

      // Parse amounts - API returns as strings
      const inAmount = parseInt(data.inAmount || '0', 10);
      const outAmount = parseInt(data.outAmount || '0', 10);

      if (inAmount === 0 || outAmount === 0) {
        logger.debug({ inAmount: data.inAmount, outAmount: data.outAmount }, 'Invalid Jupiter amounts');
        throw new SwapServiceError(
          'Invalid Jupiter API response: invalid amounts',
          'INVALID_RESPONSE',
          { response: data }
        );
      }

      // Price impact can be in priceImpactPct or priceImpact field
      const priceImpactValue = data.priceImpactPct ?? data.priceImpact ?? 0;
      const priceImpact = typeof priceImpactValue === 'string'
        ? parseFloat(priceImpactValue)
        : priceImpactValue;

      return {
        requestId: data.requestId,
        inputAmount: inAmount,
        outputAmount: outAmount,
        priceImpact: priceImpact || 0,
        slippageBps: data.slippageBps || 0,
        transaction: data.transaction || null, // May be null if taker not provided
        routes: data.routePlan || null,
        swapType: data.swapType || 'aggregator',
        swapPayload: data, // Store full Jupiter API response
      };
    } catch (error) {
      if (error instanceof SwapServiceError) {
        throw error;
      }

      if (error instanceof Error) {
        throw new SwapServiceError(
          `Failed to get quote from Jupiter: ${error.message}`,
          'QUOTE_FAILED',
          { originalError: error.message }
        );
      }

      throw new SwapServiceError(
        'Failed to get quote from Jupiter: Unknown error',
        'QUOTE_FAILED'
      );
    }
  }

  /**
   * Execute a swap based on a quote
   * 
   * For simulation mode, returns the quote data without executing.
   * For live mode, executes the swap on-chain via Jupiter API.
   * 
   * @param request - Swap execution request
   * @returns Swap result with actual amounts and transaction hash
   * @throws SwapServiceError if execution fails
   */
  async executeSwap(request: SwapExecuteRequest): Promise<SwapResult> {
    const { quote, walletAddress, isSimulation } = request;

    // For simulation mode, return mock result based on quote
    if (isSimulation) {
      return {
        success: true,
        transactionHash: null, // No on-chain transaction
        inputAmount: quote.inputAmount,
        outputAmount: quote.outputAmount,
        actualPrice: quote.inputAmount / quote.outputAmount,
        fees: 0, // Fees not available in quote
        slippage: quote.slippageBps / 100, // Convert basis points to percentage
        priceImpact: quote.priceImpact,
        routes: quote.routes,
        swapPayload: quote.swapPayload, // Pass through full payload
      };
    }

    // ========================================
    // LIVE MODE - Sign and execute on-chain
    // ========================================

    // 1. Validate we have a transaction from the quote
    if (!quote.transaction) {
      throw new SwapServiceError(
        'No transaction in quote. Ensure taker wallet was provided in quote request.',
        'MISSING_TRANSACTION',
        { requestId: quote.requestId }
      );
    }

    // 2. Get keypair from wallet store
    const keypair = walletStore.getKeypair(walletAddress);
    if (!keypair) {
      throw new SwapServiceError(
        `Wallet not loaded: ${walletAddress}. Ensure WALLET_1, WALLET_2, etc. are configured in environment.`,
        'WALLET_NOT_FOUND',
        { walletAddress }
      );
    }

    logger.debug({ wallet: walletAddress.slice(0, 8) }, 'Signing Jupiter transaction');

    // 3. Sign the transaction
    const signedTransaction = this.signTransaction(quote.transaction, keypair);

    logger.debug('Submitting signed transaction to Jupiter');

    // 4. Submit to Jupiter execute endpoint
    const result = await this.submitToJupiter(signedTransaction, quote.requestId);

    logger.debug({ signature: result.signature }, 'Jupiter swap executed');

    // 5. Parse and return result
    // inputAmountResult = amount that went into the swap (for price calculation)
    const inputAmount = result.inputAmountResult
      ? parseInt(result.inputAmountResult, 10)
      : quote.inputAmount;
    const outputAmount = result.outputAmountResult
      ? parseInt(result.outputAmountResult, 10)
      : quote.outputAmount;
    // totalInputAmount = total token debited (swap + protocol fee, NOT network fees)
    const totalInputAmount = result.totalInputAmount
      ? parseInt(String(result.totalInputAmount), 10)
      : undefined;
    // totalOutputAmount = total token credited (swap minus protocol fee, NOT network fees)
    const totalOutputAmount = result.totalOutputAmount
      ? parseInt(String(result.totalOutputAmount), 10)
      : undefined;

    // Store entire swap payload for agent_transactions: both order (quote) and execute API responses
    const fullSwapPayload = {
      orderResponse: quote.swapPayload ?? null,
      executeResponse: result,
    };

    return {
      success: true,
      transactionHash: result.signature || null,
      inputAmount,
      outputAmount,
      totalInputAmount,
      totalOutputAmount,
      actualPrice: inputAmount / outputAmount,
      fees: 0, // Fees are included in totalInputAmount when present
      slippage: quote.slippageBps / 100,
      priceImpact: quote.priceImpact,
      routes: quote.routes,
      swapPayload: fullSwapPayload,
    };
  }

  /**
   * Sign a base64-encoded transaction with the wallet keypair
   * 
   * @param base64Transaction - Base64-encoded unsigned transaction from Jupiter
   * @param keypair - Solana keypair for signing
   * @returns Base64-encoded signed transaction
   */
  private signTransaction(base64Transaction: string, keypair: Keypair): string {
    // Decode base64 to buffer
    const transactionBuffer = Buffer.from(base64Transaction, 'base64');

    // Deserialize as VersionedTransaction (Jupiter uses v0 transactions)
    const transaction = VersionedTransaction.deserialize(transactionBuffer);

    // Sign the transaction
    transaction.sign([keypair]);

    // Serialize and re-encode to base64
    const signedBuffer = transaction.serialize();
    return Buffer.from(signedBuffer).toString('base64');
  }

  /**
   * Submit signed transaction to Jupiter execute endpoint
   * 
   * @param signedTransaction - Base64-encoded signed transaction
   * @param requestId - Request ID from the order/quote response
   * @returns Jupiter execute response with transaction signature
   * @throws SwapServiceError if execution fails
   */
  private async submitToJupiter(
    signedTransaction: string,
    requestId: string
  ): Promise<JupiterExecuteResponse> {
    const apiKey = getJupiterApiKey();
    if (!apiKey) {
      throw new SwapServiceError(
        'Jupiter API key required for swap execution',
        'API_KEY_MISSING'
      );
    }

    try {
      const response = await this.executeWithRetry(async () => {
        const res = await fetch(`${JUPITER_API_BASE_URL}/v1/execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
          },
          body: JSON.stringify({
            signedTransaction,
            requestId,
          }),
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => 'Unknown error');
          logger.warn({ status: res.status, error: errorText }, 'Jupiter execute API error');

          const error = new Error(`Jupiter execute failed: ${res.status} - ${errorText}`) as Error & { status: number };
          error.status = res.status;
          throw error;
        }

        return res;
      });

      const result = await response.json() as JupiterExecuteResponse;

      // Check for failed status
      if (result.status === 'Failed') {
        logger.warn({ code: result.code, error: result.error, requestId }, 'Jupiter swap execution failed');
        throw new SwapServiceError(
          `Swap execution failed: ${result.error || 'Unknown error'}`,
          'SWAP_FAILED',
          {
            code: result.code,
            error: result.error,
            requestId,
          }
        );
      }

      // Validate we got a signature
      if (!result.signature) {
        throw new SwapServiceError(
          'Swap succeeded but no transaction signature returned',
          'MISSING_SIGNATURE',
          { result }
        );
      }

      return result;
    } catch (error) {
      if (error instanceof SwapServiceError) {
        throw error;
      }

      if (error instanceof Error) {
        throw new SwapServiceError(
          `Failed to execute swap via Jupiter: ${error.message}`,
          'EXECUTE_FAILED',
          { originalError: error.message }
        );
      }

      throw new SwapServiceError(
        'Failed to execute swap via Jupiter: Unknown error',
        'EXECUTE_FAILED'
      );
    }
  }
}

