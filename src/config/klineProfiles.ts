export type KlineProfileId = "baseline" | "scalper" | "swing";

export interface KlineProfileDefinition {
  id: KlineProfileId;
  description: string;
  intervals: Array<{
    frame: string;
    limit: number;
  }>;
  retentionBuffer?: number;
}

// scalper: {
//   id: "scalper",
//   description: "高频短线：1m/5m/15m/1h，侧重敏捷触发",
//   intervals: [
//     { frame: "1m", limit: 120 },
//     { frame: "5m", limit: 80 },
//     { frame: "15m", limit: 96 },
//     { frame: "1h", limit: 36 },
//   ],
//   retentionBuffer: 24,
// }

const profiles: Record<KlineProfileId, KlineProfileDefinition> = {
  baseline: {
    id: "baseline",
    description: "标准裸K：5m/15m/1h/4h，兼顾短中期节奏",
    intervals: [
      { frame: "5m", limit: 48 },
      { frame: "15m", limit: 64 },
      { frame: "1h", limit: 72 },
      { frame: "4h", limit: 36 },
    ],
    retentionBuffer: 16,
  },
  scalper: {
    id: "scalper",
    description: "高频短线：1m/5m/15m/1h，侧重敏捷触发",
    intervals: [
      { frame: "15m", limit: 96 },
    ],
    retentionBuffer: 24,
  },
  swing: {
    id: "swing",
    description: "低频波段：15m/1h/4h/1d，强调趋势与回撤",
    intervals: [
      { frame: "15m", limit: 96 },
      { frame: "1h", limit: 120 },
      { frame: "4h", limit: 90 },
      { frame: "1d", limit: 60 },
    ],
    retentionBuffer: 20,
  },
};

export function getKlineProfile(): KlineProfileDefinition {
  const raw = process.env.NAKED_K_PROFILE?.trim()?.toLowerCase();
  if (!raw) {
    return profiles.baseline;
  }
  switch (raw) {
    case "baseline":
    case "default":
      return profiles.baseline;
    case "scalper":
    case "high-frequency":
    case "highfreq":
      return profiles.scalper;
    case "swing":
    case "low-frequency":
    case "lowfreq":
    case "swing-trend":
      return profiles.swing;
    default:
      return profiles.baseline;
  }
}

export function getRetentionFor(frame: string, profile: KlineProfileDefinition): number {
  const entry = profile.intervals.find(({ frame: value }) => value === frame);
  if (!entry) {
    return 0;
  }
  const buffer = profile.retentionBuffer ?? Math.ceil(entry.limit * 0.2);
  return entry.limit + buffer;
}

