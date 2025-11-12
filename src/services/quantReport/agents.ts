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
        "你是一名负责识别经典高频交易形态的图表分析助理。请结合常见形态（头肩、双底、楔形、旗形、三角形、V 反转等）给出明确判断，仅当形态清晰且已接近完成时才做交易结论。",
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
    maxOutputTokens: 600,
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
    maxOutputTokens: 600,
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

输出 JSON：
{
  "forecast_horizon": "预测未来几根 K 线",
  "decision": "LONG/SHORT/OBSERVE",
  "justification": "核心结论",
  "risk_reward_ratio": "1.2~1.8 范围的小数"
}
请严格遵守以下要求：仅输出一个 JSON 对象，字段为 forecast_horizon、decision、justification、risk_reward_ratio。justification 不得超过 120 个字符，禁止换行或额外解释。`;

  const result = await generateObject({
    model: openai.chat(decisionModel),
    prompt,
    maxOutputTokens: 400,
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
