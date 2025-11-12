import { createOpenAI } from "@ai-sdk/openai";
import { generateText, generateObject } from "ai";
import { z } from "zod";
import type { QuantReportContext, QuantDecision } from "./types";
import { QUANT_AGENT_CONFIG } from "../../config/quantAgentConfig";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
  baseURL: process.env.OPENAI_BASE_URL || undefined,
});

const visionModel = QUANT_AGENT_CONFIG.models.visionModel;
const decisionModel = QUANT_AGENT_CONFIG.models.decisionModel;

export async function runPatternAgent(ctx: QuantReportContext): Promise<string> {
  const messages = [
    {
      role: "system" as const,
      content:
        `你是一名负责识别经典高频交易形态的图表分析助理。请参考以下经典 K 线形态：
        1. 反头肩底：由三个低点组成，中间低点最低且整体对称，常预示即将上行。
        2. 双底：两个接近的低点，中间伴随反弹，整体呈 “W” 形。
        3. 圆弧底：价格缓慢下行后再缓慢回升，形如 “U” 字。
        4. 隐形底：水平整理后突然向上突破。
        5. 下降楔形：价格下行区间逐步收敛，通常向上突破。
        6. 上升楔形：价格缓慢上行但区间收窄，常向下跌破。
        7. 上升三角形：支撑线抬升、上方阻力水平，突破多向上。
        8. 下降三角形：阻力线下压、下方支撑水平，常向下跌破。
        9. 多头旗形：急涨后短暂回撤整理，再继续向上。
        10. 空头旗形：急跌后短暂反弹整理，再继续向下。
        11. 矩形：在水平支撑与阻力间来回震荡。
        12. 孤岛反转：前后两个跳空朝向相反，形成孤立价格岛。
        13. V 型反转：急跌后迅速反弹，或相反。
        14. 圆弧顶 / 圆弧底：价格缓慢筑顶或筑底，呈弧形。
        15. 扩散三角形：高低点逐渐发散，波动加剧。
        16. 对称三角形：高低点同时收敛至尖端，后续通常迎来突破。
        给出明确判断，仅当形态清晰且已接近完成时才做交易结论。`
    },
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: `这是一张 ${ctx.symbol} 在 ${ctx.frame.frame} 周期的 K 线图，请说明是否存在可交易的经典形态、形态阶段以及多空含义。`,
        },
        {
          type: "image" as const,
          image: `data:image/png;base64,${ctx.patternImageBase64}`,
        },
      ],
    },
  ];

  const { text } = await generateText({
    model: openai.chat(visionModel),
    messages,
    maxOutputTokens: 2048,
    temperature: 0.4,
  });
  return text?.trim() || "未能识别出有效形态。";
}

export async function runTrendAgent(ctx: QuantReportContext): Promise<string> {
  const messages = [
    {
      role: "system" as const,
      content:
        "你是一名服务于高频交易场景的趋势识别助理。请阅读带有支撑/阻力趋势线的 K 线图，判断短期趋势方向（上行/下行/震荡），并说明与趋势线的关系（突破、回踩或受压）。",
    },
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: `请分析 ${ctx.symbol} 在 ${ctx.frame.frame} 的趋势线图，指出：1）当前趋势；2）关键支撑/阻力是否被突破；3）多空情绪与风险。`,
        },
        {
          type: "image" as const,
          image: `data:image/png;base64,${ctx.trendImageBase64}`,
        },
      ],
    },
  ];

  const { text } = await generateText({
    model: openai.chat(visionModel),
    messages,
    maxOutputTokens: 2048,
    temperature: 0.4,
  });
  return text?.trim() || "未能识别出明确趋势。";
}

export interface DecisionInput {
  symbol: string;
  frame: string;
  indicatorReport: string;
  patternReport: string;
  trendReport: string;
}

const decisionSchema = z.object({
  forecast_horizon: z.string().max(64),
  decision: z.enum(["LONG", "SHORT", "OBSERVE"]),
  justification: z.string().max(160),
  risk_reward_ratio: z.string(),
});

export async function runDecisionAgent(input: DecisionInput): Promise<QuantDecision> {
  const prompt = `你是一名负责 ${input.symbol} 当前 ${input.frame} K 线的高频量化交易分析师。你的任务是立刻下达执行指令：只能是 LONG 或 SHORT，若信息不足可输出 OBSERVE 并说明原因。

请综合以下报告的力度、方向一致性与信号时序做出决策：

【技术指标报告】
${input.indicatorReport}

【形态报告】
${input.patternReport}

【趋势报告】
${input.trendReport}

`;

  const result = await generateObject({
    model: openai.chat(decisionModel),
    prompt,
    maxOutputTokens: 4096,
    temperature: 0.2,
    schema: decisionSchema,
  });

  const object = result.object;
  return {
    forecastHorizon: object.forecast_horizon,
    decision: object.decision,
    justification: object.justification,
    riskRewardRatio: object.risk_reward_ratio,
    rawText: result.text || JSON.stringify(object),
  };
}
