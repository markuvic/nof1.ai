export type ExchangeId = "gate" | "binance";

export interface ExchangeOrderParams {
  contract: string;
  size: number;
  price?: number;
  tif?: string;
  reduceOnly?: boolean;
  autoSize?: string;
  stopLoss?: number;
  takeProfit?: number;
}

export interface ExchangeClient {
  getFuturesTicker(contract: string, retries?: number): Promise<any>;
  getFuturesCandles(
    contract: string,
    interval?: string,
    limit?: number,
    retriesOrOptions?: number | { startTime?: number; endTime?: number; retries?: number },
  ): Promise<any>;
  getFuturesAccount(retries?: number): Promise<any>;
  getPositions(retries?: number): Promise<any>;
  placeOrder(params: ExchangeOrderParams): Promise<any>;
  getOrder(orderId: string): Promise<any>;
  cancelOrder(orderId: string): Promise<any>;
  getOpenOrders(contract?: string): Promise<any>;
  setLeverage(contract: string, leverage: number): Promise<any>;
  getFundingRate(contract: string): Promise<any>;
  getFundingRateHistory(contract: string, limit?: number): Promise<any>;
  getContractInfo(contract: string): Promise<any>;
  getAllContracts(): Promise<any>;
  getOrderBook(contract: string, limit?: number): Promise<any>;
  getMyTrades(contract?: string, limit?: number): Promise<any>;
  getPositionHistory(
    contract?: string,
    limit?: number,
    offset?: number,
  ): Promise<any>;
  getSettlementHistory(
    contract?: string,
    limit?: number,
    offset?: number,
  ): Promise<any>;
  getOrderHistory(contract?: string, limit?: number): Promise<any>;
}
