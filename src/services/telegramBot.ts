import { createPinoLogger } from "@voltagent/logger";
import { createClient } from "@libsql/client";
import { createExchangeClient, isDryRunMode } from "./exchanges";
import { normalizeAccountSnapshot } from "./accountMetrics";
import { getQuantoMultiplier } from "../utils/contractUtils";

const logger = createPinoLogger({
  name: "telegram-bot",
  level: "info",
});

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type TelegramMessage = {
  message_id: number;
  date: number;
  text?: string;
  chat: {
    id: number;
    type: string;
    title?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  entities?: Array<{ type: string; offset: number; length: number }>;
};

type TradeNotification =
  | {
      kind: "open";
      symbol: string;
      side: "long" | "short";
      leverage: number;
      contracts: number;
      baseAmount: number;
      entryPrice: number;
      margin: number;
      notional: number;
    }
  | {
      kind: "close";
      symbol: string;
      side: "long" | "short";
      contracts: number;
      baseAmount: number;
      entryPrice: number;
      exitPrice: number;
      pnl: number;
      fee: number;
    };

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_BASE_URL = TELEGRAM_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_TOKEN}`
  : "";

const allowedChats = new Set<string>();
const notifyChats = new Set<string>();
let pollingActive = false;
let stopRequested = false;
let updateOffset = 0;
let botReady = false;

const dbClient = createClient({
  url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
});

const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseChatList(value?: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function resolveNotifyTargets(): string[] {
  if (notifyChats.size > 0) return [...notifyChats];
  if (allowedChats.size > 0) return [...allowedChats];
  return [];
}

async function callTelegramApi<T = any>(
  method: string,
  payload: Record<string, unknown>,
): Promise<T | null> {
  if (!TELEGRAM_BASE_URL) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35_000);
  try {
    const response = await fetch(`${TELEGRAM_BASE_URL}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!data || data.ok !== true) {
      logger.warn(
        `Telegram API 调用失败 (${method}): ${
          data?.description ?? response.statusText
        }`,
      );
      return null;
    }
    return data.result as T;
  } catch (error) {
    logger.warn(`Telegram API 调用异常 (${method}): ${(error as Error).message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function isTelegramReady(): boolean {
  return botReady;
}

async function sendMessage(
  chatId: string,
  text: string,
  parseMode: "HTML" | "Markdown" = "HTML",
) {
  if (!botReady || !TELEGRAM_BASE_URL) return;
  await callTelegramApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  });
}

async function broadcastMessage(
  text: string,
  parseMode: "HTML" | "Markdown" = "HTML",
) {
  if (!botReady) return;
  const targets = resolveNotifyTargets();
  if (targets.length === 0) {
    logger.warn("Telegram 通知已丢弃：未配置可通知的 chat id");
    return;
  }
  await Promise.all(
    targets.map((chatId) =>
      sendMessage(chatId, text, parseMode).catch((error) => {
        logger.warn(
          `发送 Telegram 消息到 ${chatId} 失败: ${(error as Error).message}`,
        );
      }),
    ),
  );
}

function registerChatId(chatId: string, allowAutoEnroll: boolean) {
  if (allowedChats.size === 0 || allowedChats.has(chatId)) {
    allowedChats.add(chatId);
    if (allowAutoEnroll) {
      notifyChats.add(chatId);
    }
    return true;
  }
  return false;
}

async function handleStatusCommand(chatId: string) {
  try {
    const exchangeClient = createExchangeClient();
    const account = await exchangeClient.getFuturesAccount();
    const snapshot = normalizeAccountSnapshot(account);

    const initialResult = await dbClient.execute(
      "SELECT total_value FROM account_history ORDER BY timestamp ASC LIMIT 1",
    );
    const initialBalance = initialResult.rows[0]
      ? Number.parseFloat(initialResult.rows[0].total_value as string)
      : snapshot.equity;
    const totalReturn = initialBalance > 0
      ? ((snapshot.equity - initialBalance) / initialBalance) * 100
      : 0;

    const parts = [
      `<b>账户概览 (${isDryRunMode() ? "Dry-Run" : "Live"})</b>`,
      `<b>权益：</b>${snapshot.equity.toFixed(2)} USDT`,
      `<b>可用余额：</b>${snapshot.availableBalance.toFixed(2)} USDT`,
      `<b>仓位保证金：</b>${snapshot.positionMargin.toFixed(2)} USDT`,
      `<b>未实现盈亏：</b>${snapshot.unrealisedPnl >= 0 ? "+" : ""}${snapshot.unrealisedPnl.toFixed(2)} USDT`,
      `<b>累计收益：</b>${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)}%`,
    ];

    await sendMessage(chatId, parts.join("\n"));
  } catch (error) {
    await sendMessage(
      chatId,
      `<b>获取账户信息失败：</b>${escapeHtml((error as Error).message)}`,
    );
  }
}

async function handlePositionsCommand(chatId: string) {
  try {
    const exchangeClient = createExchangeClient();
    const positions = await exchangeClient.getPositions();
    const active = positions.filter(
      (p: any) => Number.parseFloat(p.size || "0") !== 0,
    );
    if (active.length === 0) {
      await sendMessage(chatId, "<b>当前无持仓。</b>");
      return;
    }

    const headers = ["Symbol", "Dir", "Contracts", "Base", "Lvg", "Entry", "Mark", "PnL"];
    const rows: string[][] = [headers];

    for (const pos of active) {
      const size = Number.parseFloat(pos.size || "0");
      const symbol = (pos.contract || "").replace("_USDT", "");
      const entryPrice = Number.parseFloat(pos.entryPrice || "0");
      const markPrice = Number.parseFloat(pos.markPrice || "0");
      const leverage = Number.parseFloat(pos.leverage || "1");
      const pnl = Number.parseFloat(pos.unrealisedPnl || "0");
      const multiplier = await getQuantoMultiplier(pos.contract || `${symbol}_USDT`);
      const baseAmount = Math.abs(size) * multiplier;

      rows.push([
        symbol,
        size >= 0 ? "LONG" : "SHORT",
        Math.abs(size).toString(),
        baseAmount.toFixed(baseAmount < 1 ? 4 : 2),
        `${leverage.toFixed(0)}x`,
        entryPrice.toFixed(2),
        markPrice.toFixed(2),
        `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
      ]);
    }

    const colWidths = headers.map((_, index) =>
      Math.max(...rows.map((row) => row[index].length)) + 2,
    );

    const table = rows
      .map((row) =>
        row
          .map((cell, idx) => cell.padEnd(colWidths[idx], " "))
          .join(""),
      )
      .join("\n");

    const summary = rows.length > 1
      ? `<b>持仓共 ${rows.length - 1} 个</b>\n`
      : "";

    await sendMessage(
      chatId,
      `${summary}<pre>${escapeHtml(table)}</pre>`,
    );
  } catch (error) {
    await sendMessage(
      chatId,
      `<b>获取持仓失败：</b>${escapeHtml((error as Error).message)}`,
    );
  }
}

async function handleDecisionCommand(chatId: string) {
  try {
    const result = await dbClient.execute(
      `SELECT timestamp, iteration, decision FROM agent_decisions ORDER BY timestamp DESC LIMIT 1`,
    );
    if (result.rows.length === 0) {
      await sendMessage(chatId, "<b>暂无 AI 决策记录。</b>");
      return;
    }
    const row: any = result.rows[0];
    const timestamp = new Date(row.timestamp as string).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const decision = String(row.decision || "").trim();
    const text = [
      `<b>最新 AI 决策</b>`,
      `<b>时间：</b>${escapeHtml(timestamp)}`,
      `<b>迭代：</b>#${row.iteration}`,
      `<pre>${escapeHtml(decision.slice(0, 4000))}</pre>`,
    ].join("\n");
    await sendMessage(chatId, text);
  } catch (error) {
    await sendMessage(
      chatId,
      `<b>获取决策失败：</b>${escapeHtml((error as Error).message)}`,
    );
  }
}

async function handleHelpCommand(chatId: string) {
  const text = [
    "<b>可用命令</b>",
    "/status - 查看账户概况",
    "/positions - 查看当前持仓",
    "/pnl - 查看账户盈亏",
    "/decision - 获取最新 AI 决策摘要",
    "/help - 查看帮助信息",
  ].join("\n");
  await sendMessage(chatId, text);
}

async function handleCommand(chatId: string, text: string) {
  const command = text.split(" ")[0].toLowerCase();
  switch (command) {
    case "/start":
      notifyChats.add(chatId);
      await sendMessage(
        chatId,
        "<b>欢迎使用 Telegram 通知机器人。</b>\n输入 /help 查看可用命令。",
      );
      break;
    case "/help":
      await handleHelpCommand(chatId);
      break;
    case "/status":
    case "/pnl":
      await handleStatusCommand(chatId);
      break;
    case "/positions":
      await handlePositionsCommand(chatId);
      break;
    case "/decision":
      await handleDecisionCommand(chatId);
      break;
    default:
      await sendMessage(
        chatId,
        `<b>未知命令：</b>${escapeHtml(command)}\n输入 /help 查看可用命令。`,
      );
      break;
  }
}

async function processUpdate(update: TelegramUpdate) {
  const message = update.message;
  if (!message || !message.text) return;
  const chatId = message.chat?.id?.toString();
  if (!chatId) return;

  const allowAutoEnroll = notifyChats.size === 0 && allowedChats.size === 0;
  const allowed = registerChatId(chatId, allowAutoEnroll);
  if (!allowed) {
    logger.warn(`拒绝来自未授权 chat(${chatId}) 的命令请求。`);
    return;
  }

  const commandEntity = message.entities?.find((entity) =>
    entity.type === "bot_command"
  );
  if (!commandEntity) {
    await sendMessage(
      chatId,
      "<b>请使用命令形式与机器人交互。输入 /help 查看说明。</b>",
    );
    return;
  }

  const commandText = message.text
    .substr(commandEntity.offset, commandEntity.length)
    .trim()
    .toLowerCase();
  await handleCommand(chatId, commandText);
}

async function pollUpdatesLoop() {
  if (!TELEGRAM_BASE_URL) return;
  pollingActive = true;
  logger.info("Telegram 机器人开始轮询更新。");

  while (!stopRequested) {
    try {
      const result = await callTelegramApi<any>("getUpdates", {
        offset: updateOffset,
        timeout: 30,
        allowed_updates: ["message"],
      });
      if (Array.isArray(result)) {
        for (const update of result as TelegramUpdate[]) {
          updateOffset = Math.max(updateOffset, update.update_id + 1);
          await processUpdate(update);
        }
      }
    } catch (error) {
      logger.warn(
        `Telegram 轮询异常: ${(error as Error).message}，5秒后重试。`,
      );
      await delay(5000);
    }
  }

  pollingActive = false;
  logger.info("Telegram 轮询已停止。");
}

export async function initTelegramBot(): Promise<void> {
  if (!TELEGRAM_TOKEN) {
    logger.info("未配置 TELEGRAM_BOT_TOKEN，跳过 Telegram 机器人初始化。");
    return;
  }
  if (botReady) {
    logger.info("Telegram 机器人已初始化，无需重复启动。");
    return;
  }

  parseChatList(
    process.env.TELEGRAM_ALLOWED_CHAT_IDS ??
      process.env.TELEGRAM_CHAT_IDS,
  ).forEach((chatId) => allowedChats.add(chatId));
  parseChatList(
    process.env.TELEGRAM_NOTIFY_CHAT_IDS ??
      process.env.TELEGRAM_CHAT_IDS,
  ).forEach((chatId) => notifyChats.add(chatId));

  await callTelegramApi("setMyCommands", {
    commands: [
      { command: "status", description: "查看账户概况" },
      { command: "positions", description: "查看当前持仓" },
      { command: "pnl", description: "查看账户盈亏" },
      { command: "decision", description: "查看最新 AI 决策" },
      { command: "help", description: "查看帮助指令" },
    ],
  });

  botReady = true;
  stopRequested = false;
  updateOffset = 0;
  pollUpdatesLoop();
  logger.info("Telegram 机器人已启动。");
}

export async function stopTelegramBot(): Promise<void> {
  stopRequested = true;
  if (!botReady) return;
  logger.info("正在关闭 Telegram 机器人...");
  let wait = 0;
  while (pollingActive && wait < 20) {
    await delay(200);
    wait++;
  }
  botReady = false;
  logger.info("Telegram 机器人已关闭。");
}

export async function sendTradeNotification(payload: TradeNotification) {
  if (!botReady) return;
  const modeLabel = isDryRunMode() ? "Dry-Run" : "Live";
  if (payload.kind === "open") {
    const text = [
      `<b>📈 开仓通知 (${modeLabel})</b>`,
      `<b>合约：</b>${escapeHtml(payload.symbol)} | <b>方向：</b>${payload.side.toUpperCase()}`,
      `<b>杠杆：</b>${payload.leverage.toFixed(0)}x | <b>保证金：</b>${payload.margin.toFixed(2)} USDT`,
      `<b>成交价：</b>${payload.entryPrice.toFixed(4)} USDT`,
      `<b>合约张数：</b>${payload.contracts.toString()} | <b>名义价值：</b>${payload.notional.toFixed(2)} USDT`,
      `<b>基础数量：</b>${payload.baseAmount.toFixed(payload.baseAmount < 1 ? 4 : 2)}`,
    ].join("\n");
    await broadcastMessage(text);
  } else {
    const pnlLabel = `${payload.pnl >= 0 ? "+" : ""}${payload.pnl.toFixed(2)} USDT`;
    const text = [
      `<b>📉 平仓通知 (${modeLabel})</b>`,
      `<b>合约：</b>${escapeHtml(payload.symbol)} | <b>方向：</b>${payload.side.toUpperCase()}`,
      `<b>平仓价：</b>${payload.exitPrice.toFixed(4)} USDT`,
      `<b>持仓成本：</b>${payload.entryPrice.toFixed(4)} USDT`,
      `<b>合约张数：</b>${payload.contracts.toString()} | <b>基础数量：</b>${payload.baseAmount.toFixed(payload.baseAmount < 1 ? 4 : 2)}`,
      `<b>盈亏：</b>${pnlLabel} (含手续费 ${payload.fee.toFixed(2)} USDT)`,
    ].join("\n");
    await broadcastMessage(text);
  }
}

interface AlertNotificationPayload {
  title?: string;
  lines: string[];
  emoji?: string;
}

export async function sendAlertNotification(payload: AlertNotificationPayload) {
  if (!botReady) return;
  const emoji = payload.emoji ?? "⚡";
  const title = payload.title ?? "系统通知";
  const header = `<b>${escapeHtml(`${emoji} ${title}`)}</b>`;
  const body = payload.lines
    .map((line) => escapeHtml(line))
    .join("\n");
  const text = [header, body].filter(Boolean).join("\n");
  await broadcastMessage(text);
}
