'use client';

/**
 * Performance Overview page
 * 
 * Main analytics dashboard view with agent overview and quick links.
 */

import { useState, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card';
import { Button } from '@/shared/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/shared/components/ui/tabs';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import {
  TrendingUp,
  Wallet,
  Bot,
  DollarSign,
  Percent,
  Target,
  BarChart3,
} from 'lucide-react';
// Lazy load heavy chart components - they're only shown in the chart tab
const AreaChart = dynamic(() => import('recharts').then(mod => mod.AreaChart), { ssr: false });
const Area = dynamic(() => import('recharts').then(mod => mod.Area), { ssr: false });
const XAxis = dynamic(() => import('recharts').then(mod => mod.XAxis), { ssr: false });
const YAxis = dynamic(() => import('recharts').then(mod => mod.YAxis), { ssr: false });
const CartesianGrid = dynamic(() => import('recharts').then(mod => mod.CartesianGrid), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then(mod => mod.Tooltip), { ssr: false });
const ResponsiveContainer = dynamic(() => import('recharts').then(mod => mod.ResponsiveContainer), { ssr: false });

import { LivePositionsTable } from '@/features/positions';
import { RecentTradesTable } from '@/features/trades';
import { useAgentSelection } from '@/shared/contexts/agent-selection.context';
import { useWebSocket } from '@/infrastructure/websocket/hooks/use-websocket';
import { useAgentPerformance, useAgentBalanceHistory } from '@/features/agents';
import { useCurrency } from '@/shared/contexts/currency.context';
import { useWallet } from '@/shared/contexts/wallet.context';
import { useTradingMode } from '@/shared/contexts/trading-mode.context';
import { PageSkeleton, ErrorState } from '@/shared/components';
import { formatCurrency } from '@/shared/utils/formatting';
import { useDataSources } from '@/infrastructure/api/hooks/use-data-sources';

export default function PerformanceOverviewPage() {
  const router = useRouter();
  const { selectedAgentId } = useAgentSelection();
  const { currencyPreference, solPrice } = useCurrency();
  const [timeframe, setTimeframe] = useState<'24h' | 'all'>('all');
  const { data: dataSources, isLoading: isLoadingDataSources } = useDataSources();
  const { tradingMode } = useTradingMode();
  const { wallets, isLoading: isLoadingWallets } = useWallet();

  // Get wallet for current trading mode
  const walletForMode = wallets.find((w) => w.walletType === tradingMode);
  const walletAddress = walletForMode?.walletAddress;

  // 1. Use WebSocket at top level
  const {
    positions: allPositions,
    isConnected,
    isConnecting,
    connectionError,
  } = useWebSocket(selectedAgentId, {
    autoConnect: true,
  });

  // Filter WebSocket positions by current trading mode's wallet
  // WebSocket returns positions from ALL wallets, we only want ones for the current mode
  const positions = useMemo(() => {
    if (!walletAddress) return [];
    return allPositions.filter((p) => p.walletAddress?.toLowerCase() === walletAddress.toLowerCase());
  }, [allPositions, walletAddress]);

  // 2. Use Performance Hook with live positions (filtered by current trading mode wallet)
  const { metrics, isLoading } = useAgentPerformance(selectedAgentId, positions, timeframe, walletAddress);

  // 3. Fetch balance history for chart (requires walletAddress)
  const { data: balanceHistoryData, isLoading: isLoadingBalanceHistory } = useAgentBalanceHistory(
    selectedAgentId,
    walletAddress,
    timeframe
  );

  // Check if minimum required data sources are missing
  // Only evaluate after loading is complete to prevent flash of incorrect state
  const isMissingRequiredDataSources = 
    !isLoadingDataSources && 
    (!dataSources?.jupiter.configured || !dataSources?.solPriceFeed.configured);

  // Calculate display values based on currency preference
  const portfolioBalance = currencyPreference === 'USD'
    ? metrics.portfolioBalanceSol * solPrice
    : metrics.portfolioBalanceSol;

  const profitLoss = currencyPreference === 'USD'
    ? metrics.totalProfitLossSol * solPrice
    : metrics.totalProfitLossSol;

  const averageReturn = metrics.averageReturn;
  const winRate = metrics.winRate;
  const totalClosedTrades = metrics.totalClosedTrades;

  // Transform balance history data for chart
  // Chart expects: { timestamp: string, balance: number }
  // Handles 3 cases:
  // 1. Multiple snapshots: map them directly
  // 2. Single snapshot: extend from that record to current time with current balance
  // 3. No snapshots: create a flat line at current balance
  const snapshotCount = balanceHistoryData?.snapshots?.length ?? 0;
  
  // Helper to format timestamps based on timeframe
  const formatTimestamp = (date: Date) => {
    if (timeframe === '24h') {
      return date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    } else {
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });
    }
  };

  // Helper to convert snapshot to chart data point
  const snapshotToChartPoint = (snapshot: { timestamp: string; portfolioBalanceSol: string }) => {
    const balanceSol = parseFloat(snapshot.portfolioBalanceSol);
    const balance = currencyPreference === 'USD'
      ? balanceSol * solPrice
      : balanceSol;
    const date = new Date(snapshot.timestamp);
    return {
      timestamp: formatTimestamp(date),
      balance,
    };
  };

  const balanceHistory = (() => {
    if (snapshotCount > 1) {
      // Multiple snapshots: map them directly
      return balanceHistoryData!.snapshots.map(snapshotToChartPoint);
    } else if (snapshotCount === 1) {
      // Single snapshot: extend from that record to current time
      const snapshot = balanceHistoryData!.snapshots[0];
      const snapshotPoint = snapshotToChartPoint(snapshot);
      const now = new Date();
      const snapshotDate = new Date(snapshot.timestamp);
      
      const nowFormatted = formatTimestamp(now);
      
      // For the chart to show a line (not just a dot), we need two distinct x-coordinates.
      // When both timestamps format to the same string (e.g., same day for "all" timeframe),
      // we need to differentiate them to create a visible line.
      if (snapshotPoint.timestamp === nowFormatted) {
        // Same formatted time - differentiate labels to show a line
        // For "all" timeframe (daily): show time to differentiate same-day points
        // For "24h" timeframe (hourly): show "Now" to differentiate same-hour points
        const snapshotLabel = timeframe === 'all'
          ? `${snapshotPoint.timestamp} ${snapshotDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}`
          : snapshotPoint.timestamp;
        const nowLabel = timeframe === 'all' ? 'Now' : `${nowFormatted} (Now)`;
        
        return [
          {
            timestamp: snapshotLabel,
            balance: snapshotPoint.balance,
          },
          {
            timestamp: nowLabel,
            balance: portfolioBalance,
          },
        ];
      }
      
      // Different formatted times: create line from snapshot to current balance
      return [
        snapshotPoint,
        {
          timestamp: nowFormatted,
          balance: portfolioBalance,
        },
      ];
    } else {
      // No snapshots: create a flat line at current balance
      const now = new Date();
      let startDate: Date;
      
      if (timeframe === '24h') {
        // Start at the start of the current hour (e.g., 14:00 if now is 14:30)
        startDate = new Date(now);
        startDate.setMinutes(0, 0, 0); // Set to start of current hour
      } else {
        // For "all time": start at the current date (start of day)
        startDate = new Date(now);
        startDate.setHours(0, 0, 0, 0); // Set to start of current day
      }

      // Both points have the same balance (current balance)
      return [
        {
          timestamp: formatTimestamp(startDate),
          balance: portfolioBalance,
        },
        {
          timestamp: formatTimestamp(now),
          balance: portfolioBalance,
        },
      ];
    }
  })();

  return (
    <div className="flex flex-col gap-4 px-4 py-6">
      {/* No Data Source Connected Alert - Only show if Jupiter or the SOL price feed is missing */}
      {isMissingRequiredDataSources && (
        <div className="flex justify-between items-start">
          <Alert className="inline-flex w-fit border-[#16B364] bg-[#16B364]/10 text-[#16B364]">
            <AlertDescription>
              <strong>No data source connected.</strong>
              <br />
              Choose an RPC provider to start ingesting Solana chain activity.{' '}
              <Link 
                href="/dashboard/integrations" 
                className="underline hover:no-underline"
              >
                Set up integrations →
              </Link>
            </AlertDescription>
          </Alert>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr,350px] gap-4">
        {/* Agent Overview Card */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <CardTitle>Agent Overview</CardTitle>
                <CardDescription>
                  Performance metrics for your trading agent
                </CardDescription>
              </div>
              <div className="mt-2 md:mt-0 md:ml-4">
                <Tabs
                  value={timeframe}
                  onValueChange={(value) => setTimeframe(value as '24h' | 'all')}
                >
                  <TabsList>
                    <TabsTrigger value="24h">Last 24 Hours</TabsTrigger>
                    <TabsTrigger value="all">All Time</TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="flex flex-col gap-0">
              {/* Metrics Grid */}
              <div>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                  <div className="rounded-lg border bg-card p-4 shadow-sm transition-all duration-200 hover:shadow-md hover:scale-[1.02]">
                    <div className="flex items-center justify-between text-sm text-muted-foreground">
                      <span>Portfolio Balance</span>
                      <DollarSign className="h-4 w-4" />
                    </div>
                    <div className="text-xl font-bold">
                      {currencyPreference === 'USD' ? '$' : ''}
                      {portfolioBalance.toLocaleString('en-US', {
                        minimumFractionDigits: currencyPreference === 'SOL' ? 4 : 2,
                        maximumFractionDigits: currencyPreference === 'SOL' ? 4 : 2,
                      })}
                      {currencyPreference === 'SOL' ? ' SOL' : ''}
                    </div>
                  </div>
                  <div className="rounded-lg border bg-card p-4 shadow-sm transition-all duration-200 hover:shadow-md hover:scale-[1.02]">
                    <div className="flex items-center justify-between text-sm text-muted-foreground">
                      <span>Profit / Loss</span>
                      <TrendingUp className="h-4 w-4" />
                    </div>
                    <div
                      className={`text-xl font-bold ${
                        profitLoss === 0 
                          ? 'text-foreground' 
                          : profitLoss > 0 
                            ? 'text-green-600' 
                            : 'text-red-600'
                      }`}
                    >
                      {formatCurrency(profitLoss, currencyPreference, solPrice, { showSign: true })}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      Total PnL after fees
                    </div>
                  </div>
                  <div className="rounded-lg border bg-card p-4 shadow-sm transition-all duration-200 hover:shadow-md hover:scale-[1.02]">
                    <div className="flex items-center justify-between text-sm text-muted-foreground">
                      <span>Average Return</span>
                      <Percent className="h-4 w-4" />
                    </div>
                    <div
                      className={`text-xl font-bold ${
                        averageReturn === 0 
                          ? 'text-foreground' 
                          : averageReturn > 0 
                            ? 'text-green-600' 
                            : 'text-red-600'
                      }`}
                    >
                      {averageReturn >= 0 ? '+' : ''}
                      {averageReturn.toFixed(2)}%
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      Based on closed trades
                    </div>
                  </div>
                  <div className="rounded-lg border bg-card p-4 shadow-sm transition-all duration-200 hover:shadow-md hover:scale-[1.02]">
                    <div className="flex items-center justify-between text-sm text-muted-foreground">
                      <span>Win Rate</span>
                      <Target className="h-4 w-4" />
                    </div>
                    <div
                      className={`text-xl font-bold ${
                        winRate === 0 
                          ? 'text-foreground' 
                          : winRate >= 50 
                            ? 'text-green-600' 
                            : 'text-red-600'
                      }`}
                    >
                      {winRate.toFixed(0)}%
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      Based on closed trades
                    </div>
                  </div>
                  <div className="rounded-lg border bg-card p-4 shadow-sm transition-all duration-200 hover:shadow-md hover:scale-[1.02]">
                    <div className="flex items-center justify-between text-sm text-muted-foreground">
                      <span>Total Closed Trades</span>
                      <BarChart3 className="h-4 w-4" />
                    </div>
                    <div className="text-xl font-bold">{totalClosedTrades}</div>
                  </div>
                </div>
              </div>

              {/* Chart */}
              <div className="h-[120px] mt-6 w-full">
                {isLoadingBalanceHistory ? (
                  <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                    Loading chart data...
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%" minHeight={120}>
                    <AreaChart data={balanceHistory}>
                    <defs>
                      <linearGradient id="colorBalance" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#16B364" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#16B364" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="#262626"
                      horizontal={true}
                      vertical={false}
                    />
                    <XAxis
                      dataKey="timestamp"
                      axisLine={{ stroke: '#262626' }}
                      padding={{ right: 20, left: 0 }} // Add padding to prevent last timestamp from being cut off
                      // Custom tick to ensure last tick is always shown
                      tick={(props: any) => {
                        const { x, y, payload, index, visibleTicksCount } = props;
                        const dataLength = balanceHistory.length;
                        const isLastTick = index === dataLength - 1;
                        const interval = timeframe === '24h' ? 4 : 5;
                        
                        // Always show first tick, ticks matching interval, and last tick
                        const shouldShow = index === 0 || index % interval === 0 || isLastTick;
                        
                        if (!shouldShow) return null;
                        
                        return (
                          <g transform={`translate(${x},${y})`}>
                            <text
                              x={0}
                              y={0}
                              dy={16}
                              textAnchor="middle"
                              fill="#9CA3AF"
                              fontSize={12}
                            >
                              {payload.value}
                            </text>
                          </g>
                        );
                      }}
                    />
                    <YAxis
                      tick={{ fill: '#9CA3AF', fontSize: 12 }}
                      axisLine={{ stroke: '#262626' }}
                      width={60}
                      tickFormatter={(value) => 
                        currencyPreference === 'USD' 
                          ? `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                          : `${value.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL`
                      }
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#121212',
                        border: '1px solid #262626',
                        borderRadius: '0.5rem',
                      }}
                      labelStyle={{ color: '#FFFFFF' }}
                      itemStyle={{ color: '#FFFFFF' }}
                      // @ts-ignore - Recharts formatter typing is complex, this works correctly at runtime
                      formatter={(value: any) => {
                        const numValue = typeof value === 'string' ? parseFloat(value) : Number(value);
                        if (isNaN(numValue)) return value;
                        const formatted = numValue.toLocaleString('en-US', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        });
                        return currencyPreference === 'USD'
                          ? [`$${formatted}`, 'Balance']
                          : [`${formatted} SOL`, 'Balance'];
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="balance"
                      stroke="#16B364"
                      strokeWidth={2}
                      fill="url(#colorBalance)"
                    />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Agent Quick Links Card */}
        <Card className="w-full">
          <CardHeader className="pb-2">
            <CardTitle>Agent Quick Links</CardTitle>
            <CardDescription>
              Quick access to important agent settings and features
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2 h-[200px] md:h-[180px]">
              <Button
                variant="outline"
                className="h-full flex flex-col items-center justify-center gap-2"
                onClick={() => router.push('/dashboard/trade-signals')}
              >
                <TrendingUp className="h-5 w-5" />
                <span>Trading Signals</span>
              </Button>
              <Button
                variant="outline"
                className="h-full flex flex-col items-center justify-center gap-2"
                onClick={() => router.push('/dashboard/wallet')}
              >
                <Wallet className="h-5 w-5" />
                <span>Configure Wallet</span>
              </Button>
              <Button
                variant="outline"
                className="h-full flex flex-col items-center justify-center gap-2"
                onClick={() => router.push('/dashboard/transactions')}
              >
                <BarChart3 className="h-5 w-5" />
                <span>Transactions</span>
              </Button>
              <Button
                variant="outline"
                className="h-full flex flex-col items-center justify-center gap-2"
                onClick={() => router.push('/dashboard/integrations')}
              >
                <Bot className="h-5 w-5" />
                <span>Integrations</span>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Live Positions */}
      <LivePositionsTable 
        positions={positions}
        isConnected={isConnected}
        isConnecting={isConnecting}
        connectionError={connectionError}
      />

      {/* Recent Trades */}
      <RecentTradesTable />
    </div>
  );
}
