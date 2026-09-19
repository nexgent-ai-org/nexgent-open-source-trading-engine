/**
 * Data Sources API Service
 * 
 * Handles data source status API calls.
 * 
 * @module infrastructure/api/services
 */

import { apiClient } from '../client/api-client';
import { extractErrorFromResponse } from '../client/error-handler';

/**
 * Data source status response
 * 
 * Note: Only contains configuration status (configured: boolean) for security.
 * Actual URLs, API keys, and other sensitive values are not exposed.
 */
export interface DataSourceStatus {
  solPriceFeed: {
    configured: boolean;
  };
  jupiter: {
    configured: boolean;
  };
  dexscreener: {
    configured: boolean;
  };
  liquidityChecks: {
    configured: boolean;
  };
  signalGeneration: {
    configured: boolean;
  };
}

export class DataSourcesService {
  /**
   * Fetch data source status
   * 
   * @returns Promise resolving to data source status
   * @throws Error if request fails
   */
  async getDataSourceStatus(): Promise<DataSourceStatus> {
    const response = await apiClient.get('/api/v1/data-sources/status');

    if (!response.ok) {
      const errorMessage = await extractErrorFromResponse(response);
      throw new Error(errorMessage || 'Failed to fetch data source status');
    }

    return response.json();
  }
}

export const dataSourcesService = new DataSourcesService();
