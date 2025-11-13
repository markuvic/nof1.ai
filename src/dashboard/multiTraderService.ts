import { MultiTraderNode } from "./nodeStore";

type TraderMeta = {
  traderName: string;
  agentProfile: string;
  exchangeProvider: string;
  port: number;
  version?: string;
  uptimeSeconds?: number;
  timestamp?: string;
  isDryRun?: boolean;
  firstBootAt?: string;
};

type TraderAccount = {
  traderName?: string;
  totalBalance: number;
  availableBalance: number;
  positionMargin: number;
  unrealisedPnl: number;
  returnPercent: number;
  initialBalance: number;
  timestamp: string;
  accountStartAt?: string | null;
  tradingIntervalMinutes?: number;
};

export type NodeSnapshot = {
  node: MultiTraderNode;
  status: "online" | "offline";
  lastSync: string | null;
  meta?: TraderMeta | null;
  account?: TraderAccount | null;
  error?: string;
};

export type DashboardOverview = {
  nodes: NodeSnapshot[];
  totals: {
    equity: number;
    available: number;
    unrealised: number;
    initialCapital: number;
    pnl: number;
    returnPercent: number;
  };
  generatedAt: string;
};

const REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.DASHBOARD_NODE_TIMEOUT_MS || "5000",
  10,
);
const CACHE_TTL_MS = Number.parseInt(
  process.env.DASHBOARD_CACHE_TTL_MS || "4000",
  10,
);

export async function fetchWithTimeout(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return (await response.json()) as Record<string, any>;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchNodeData(node: MultiTraderNode) {
  const accountPromise = fetchWithTimeout(`${node.baseUrl}/api/account`);
  const metaPromise = fetchWithTimeout(`${node.baseUrl}/api/trader/meta`).catch(
    () => null,
  );

  const [account, meta] = await Promise.allSettled([
    accountPromise,
    metaPromise,
  ]);

  const accountValue = account.status === "fulfilled" ? account.value : null;
  const metaValue = meta.status === "fulfilled" ? meta.value : null;
  const error = account.status === "rejected" ? account.reason : null;

  return { account: accountValue, meta: metaValue, error };
}

function toNumber(value: any, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function summarize(nodes: NodeSnapshot[]): DashboardOverview["totals"] {
  return nodes.reduce(
    (acc, snapshot) => {
      if (snapshot.status === "online" && snapshot.account) {
        const totalBalance = toNumber(snapshot.account.totalBalance);
        const unrealised = toNumber(snapshot.account.unrealisedPnl);
        const available = toNumber(snapshot.account.availableBalance);
        const initial = toNumber(snapshot.account.initialBalance, 0);
        const equity = totalBalance + unrealised;

        acc.equity += equity;
        acc.available += available;
        acc.unrealised += unrealised;
        acc.initialCapital += initial;
      }
      return acc;
    },
    {
      equity: 0,
      available: 0,
      unrealised: 0,
      initialCapital: 0,
      pnl: 0,
      returnPercent: 0,
    },
  );
}

let cache: {
  key: string;
  expiresAt: number;
  data: DashboardOverview;
} | null = null;

export async function buildOverview(nodes: MultiTraderNode[]) {
  const key = nodes.map((node) => `${node.id}:${node.baseUrl}`).join("|");
  const now = Date.now();
  if (cache && cache.key === key && cache.expiresAt > now) {
    return cache.data;
  }

  const snapshots = await Promise.all(
    nodes.map(async (node) => {
      try {
        const { account, meta, error } = await fetchNodeData(node);
        if (!account) {
          return {
            node,
            status: "offline" as const,
            lastSync: null,
            meta: meta as TraderMeta | null,
            account: null,
            error:
              error instanceof Error ? error.message : "无法获取账户数据",
          };
        }

        return {
          node,
          status: "online" as const,
          lastSync: account.timestamp || new Date().toISOString(),
          meta: meta as TraderMeta | null,
          account: account as TraderAccount,
        } satisfies NodeSnapshot;
      } catch (error: any) {
        return {
          node,
          status: "offline" as const,
          lastSync: null,
          account: null,
          meta: null,
          error: error?.message || "节点请求失败",
        } satisfies NodeSnapshot;
      }
    }),
  );

  const totals = summarize(snapshots);
  totals.pnl = totals.equity - totals.initialCapital;
  if (totals.initialCapital > 0) {
    totals.returnPercent =
      ((totals.equity - totals.initialCapital) / totals.initialCapital) * 100;
  } else {
    totals.returnPercent = 0;
  }

  const overview: DashboardOverview = {
    nodes: snapshots,
    totals,
    generatedAt: new Date().toISOString(),
  };

  cache = {
    key,
    data: overview,
    expiresAt: now + CACHE_TTL_MS,
  };

  return overview;
}

export function invalidateOverviewCache() {
  cache = null;
}
