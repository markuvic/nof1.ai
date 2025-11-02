/**
 * open-nof1.ai - AI 加密货币自动交易系统
 * Copyright (C) 2025 195440
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 * 
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * 查询交易所 历史仓位记录
 * 用于输出账号合约的历史仓位记录
 */

import { createExchangeClient, getActiveExchangeId } from "../src/services/exchanges/index.js";
import { createPinoLogger } from "@voltagent/logger";

const logger = createPinoLogger({
  name: "query-position-history",
  level: "info",
});

async function queryPositionHistory() {
  try {
    const exchangeId = getActiveExchangeId();
    const exchangeName = exchangeId === "gate" ? "Gate.io" : "Binance";
    const exchangeClient = createExchangeClient();
    
    logger.info("=".repeat(80));
    logger.info(`开始查询 ${exchangeName} 历史仓位记录...`);
    logger.info("=".repeat(80));
    
    // 查询历史仓位记录（已平仓的仓位）
    logger.info("\n查询历史仓位记录（已平仓的仓位结算记录）...");
    const positionHistory = await exchangeClient.getPositionHistory(undefined, 50);
    
    if (positionHistory && positionHistory.length > 0) {
      logger.info(`找到 ${positionHistory.length} 条历史仓位记录:\n`);
      
      positionHistory.forEach((position: any, index: number) => {
        const symbol = position.contract || position.symbol || "N/A";
        const quantity = position.size || position.qty || position.positionAmt || "N/A";
        const price = position.price || position.avgPrice || position.markPrice || "N/A";
        const pnl = position.pnl || position.income || "N/A";
        const fee = position.fee || position.commission || "N/A";
        const time = position.time || position.updateTime || position.tradeTime || "N/A";
        const settleType = position.settle_type || position.incomeType || "N/A";
        logger.info(`[${index + 1}] 历史仓位记录:`);
        logger.info(`  合约: ${symbol}`);
        logger.info(`  数量: ${quantity}`);
        logger.info(`  价格: ${price}`);
        logger.info(`  盈亏: ${pnl}`);
        logger.info(`  手续费: ${fee}`);
        logger.info(`  时间: ${time}`);
        logger.info(`  结算类型: ${settleType}`);
        logger.info("---");
      });
    } else {
      logger.info("暂无历史仓位记录");
    }
    
    // 查询历史结算记录（更详细的信息）
    logger.info("\n查询历史结算记录（更详细的历史仓位信息）...");
    const settlementHistory = await exchangeClient.getSettlementHistory(undefined, 50);
    
    if (settlementHistory && settlementHistory.length > 0) {
      logger.info(`找到 ${settlementHistory.length} 条历史结算记录:\n`);
      
      settlementHistory.forEach((settlement: any, index: number) => {
        const symbol = settlement.contract || settlement.symbol || "N/A";
        const settlePrice = settlement.settle_price || settlement.markPrice || "N/A";
        const settleTime = settlement.settle_time || settlement.time || settlement.updateTime || "N/A";
        const quantity = settlement.size || settlement.qty || "N/A";
        const pnl = settlement.pnl || settlement.income || "N/A";
        const fee = settlement.fee || settlement.commission || "N/A";
        logger.info(`[${index + 1}] 历史结算记录:`);
        logger.info(`  合约: ${symbol}`);
        logger.info(`  结算价格: ${settlePrice}`);
        logger.info(`  结算时间: ${settleTime}`);
        logger.info(`  仓位数量: ${quantity}`);
        logger.info(`  盈亏: ${pnl}`);
        logger.info(`  手续费: ${fee}`);
        logger.info("---");
      });
    } else {
      logger.info("暂无历史结算记录");
    }
    
    logger.info("\n" + "=".repeat(80));
    logger.info("查询完成");
    logger.info("=".repeat(80));
    
  } catch (error: any) {
    logger.error(`查询历史仓位记录失败: ${error.message}`);
    process.exit(1);
  }
}

// 执行查询
queryPositionHistory();



