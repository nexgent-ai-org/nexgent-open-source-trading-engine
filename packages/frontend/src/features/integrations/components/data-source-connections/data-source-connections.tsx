'use client';

/**
 * Data Source Connections Component
 * 
 * Displays the status of configured data sources (Jupiter, DexScreener, etc.)
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card';
import { Badge } from '@/shared/components/ui/badge';
import { CheckCircle2, XCircle, TrendingUp, Activity, Zap, DollarSign, Waves } from 'lucide-react';
import { useDataSources } from '@/infrastructure/api/hooks/use-data-sources';
import { LoadingSpinner } from '@/shared/components';

export function DataSourceConnections() {
  const { data: dataSources, isLoading: isLoadingDataSources } = useDataSources();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Data Source Connections</CardTitle>
        <CardDescription>
          Monitor the status of your configured data sources
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoadingDataSources ? (
          <div className="flex items-center justify-center p-8">
            <LoadingSpinner size="md" text="Loading data sources..." />
          </div>
        ) : (
          <div className="space-y-2.5">
            {/* Solana Price Feed */}
            <div className="rounded-lg border bg-card">
              <div className="flex items-center justify-between p-3.5 border-b bg-muted/30">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center border border-primary/20">
                      <TrendingUp className="h-5 w-5 text-primary" />
                    </div>
                    {dataSources?.solPriceFeed.configured && (
                      <div className="absolute -top-1 -right-1 h-3.5 w-3.5 rounded-full bg-green-500 border-2 border-card flex items-center justify-center">
                        <div className="h-1.5 w-1.5 rounded-full bg-white" />
                      </div>
                    )}
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm flex items-center gap-2">
                      Solana Price Feed
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      Real-time SOL/USD pricing data
                    </p>
                  </div>
                </div>
                {dataSources?.solPriceFeed.configured ? (
                  <Badge variant="default" className="bg-green-500/10 text-green-600 border-green-500/20">
                    <CheckCircle2 className="mr-1.5 h-3 w-3" />
                    Connected
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="bg-muted text-muted-foreground">
                    <XCircle className="mr-1.5 h-3 w-3" />
                    Not configured
                  </Badge>
                )}
              </div>
              <div className="p-3.5 pl-16 bg-muted/20">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="h-7 w-7 rounded-md bg-background border flex items-center justify-center">
                      <Zap className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">Jupiter</p>
                    </div>
                  </div>
                  {dataSources?.solPriceFeed.configured ? (
                    <div className="flex items-center gap-1.5 text-green-600">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span className="text-xs font-medium">Active</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <XCircle className="h-3.5 w-3.5" />
                      <span className="text-xs">Inactive</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Token Price Feed */}
            <div className="rounded-lg border bg-card">
              <div className="flex items-center justify-between p-3.5 border-b bg-muted/30">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center border border-primary/20">
                      <DollarSign className="h-5 w-5 text-primary" />
                    </div>
                    {dataSources?.jupiter.configured && (
                      <div className="absolute -top-1 -right-1 h-3.5 w-3.5 rounded-full bg-green-500 border-2 border-card flex items-center justify-center">
                        <div className="h-1.5 w-1.5 rounded-full bg-white" />
                      </div>
                    )}
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm flex items-center gap-2">
                      Token Price Feed
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      Token pricing and market data
                    </p>
                  </div>
                </div>
                {dataSources?.jupiter.configured ? (
                  <Badge variant="default" className="bg-green-500/10 text-green-600 border-green-500/20">
                    <CheckCircle2 className="mr-1.5 h-3 w-3" />
                    Connected
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="bg-muted text-muted-foreground">
                    <XCircle className="mr-1.5 h-3 w-3" />
                    Not configured
                  </Badge>
                )}
              </div>
              <div className="p-3.5 pl-16 bg-muted/20 space-y-2.5">
                {/* Jupiter */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="h-7 w-7 rounded-md bg-background border flex items-center justify-center">
                      <Activity className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">Jupiter</p>
                    </div>
                  </div>
                  {dataSources?.jupiter.configured ? (
                    <div className="flex items-center gap-1.5 text-green-600">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span className="text-xs font-medium">Active</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <XCircle className="h-3.5 w-3.5" />
                      <span className="text-xs">Inactive</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Liquidity Checks */}
            <div className="rounded-lg border bg-card">
              <div className="flex items-center justify-between p-3.5 border-b bg-muted/30">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center border border-primary/20">
                      <Waves className="h-5 w-5 text-primary" />
                    </div>
                    {dataSources?.liquidityChecks.configured && (
                      <div className="absolute -top-1 -right-1 h-3.5 w-3.5 rounded-full bg-green-500 border-2 border-card flex items-center justify-center">
                        <div className="h-1.5 w-1.5 rounded-full bg-white" />
                      </div>
                    )}
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm flex items-center gap-2">
                      Liquidity Checks
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      Token liquidity validation and analysis
                    </p>
                  </div>
                </div>
                {dataSources?.liquidityChecks.configured ? (
                  <Badge variant="default" className="bg-green-500/10 text-green-600 border-green-500/20">
                    <CheckCircle2 className="mr-1.5 h-3 w-3" />
                    Connected
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="bg-muted text-muted-foreground">
                    <XCircle className="mr-1.5 h-3 w-3" />
                    Not configured
                  </Badge>
                )}
              </div>
              <div className="p-3.5 pl-16 bg-muted/20">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="h-7 w-7 rounded-md bg-background border flex items-center justify-center">
                      <Activity className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">DexScreener</p>
                    </div>
                  </div>
                  {dataSources?.liquidityChecks.configured ? (
                    <div className="flex items-center gap-1.5 text-green-600">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span className="text-xs font-medium">Active</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <XCircle className="h-3.5 w-3.5" />
                      <span className="text-xs">Inactive</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

