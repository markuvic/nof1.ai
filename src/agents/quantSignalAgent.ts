import { createHybridAutonomousAgent } from "./hybridAutonomousAgent";

/**
 * Quant Signal Agent
 * 复用 Hybrid Autonomous Agent 的执行能力，区别在于 scheduler 会在生成 Prompt 时
 * 注入最新的量化技术报告（指标/形态/趋势 + 决策），从而让 Agent 在同一套指令下
 * 具备额外的多代理洞察。
 */
export function createQuantSignalAgent(intervalMinutes = 5) {
	return createHybridAutonomousAgent(intervalMinutes);
}
