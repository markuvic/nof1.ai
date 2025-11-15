import { createClient } from "@libsql/client";
import { createPinoLogger } from "@voltagent/logger";

const dbClient = createClient({
	url: process.env.DATABASE_URL || "file:./.voltagent/trading.db",
});

const logger = createPinoLogger({
	name: "low-frequency-defense-store",
	level: (process.env.LOG_LEVEL || "info") as any,
});

let tableEnsured = false;

async function ensureDefenseTable() {
	if (tableEnsured) {
		return;
	}
	await dbClient.execute(`
		CREATE TABLE IF NOT EXISTS position_defense_levels (
			symbol TEXT PRIMARY KEY,
			side TEXT NOT NULL,
			entry_invalidation REAL NOT NULL,
			structure_invalidation REAL NOT NULL,
			entry_breached INTEGER NOT NULL DEFAULT 0,
			structure_breached INTEGER NOT NULL DEFAULT 0,
			last_forced_decision_at TEXT,
			notes TEXT,
			updated_at TEXT NOT NULL
		)
	`);
	await dbClient.execute(`
		CREATE INDEX IF NOT EXISTS idx_position_defense_levels_side
		ON position_defense_levels(side)
	`);
	tableEnsured = true;
}

export type DefenseLevelType = "entry" | "structure";

export interface DefenseLevelRecord {
	symbol: string;
	side: "long" | "short";
	entryInvalidation: number;
	structureInvalidation: number;
	entryBreached: boolean;
	structureBreached: boolean;
	lastForcedDecisionAt?: string | null;
	notes?: string | null;
	updatedAt: string;
}

function normalizeSymbol(symbol: string): string {
	return symbol.trim().toUpperCase();
}

function normalizeSide(side: string): "long" | "short" {
	return side.toLowerCase() === "short" ? "short" : "long";
}

export async function upsertDefenseLevels(params: {
	symbol: string;
	side: "long" | "short";
	entryInvalidation: number;
	structureInvalidation: number;
	notes?: string;
}) {
	await ensureDefenseTable();
	const symbol = normalizeSymbol(params.symbol);
	const side = normalizeSide(params.side);
	const now = new Date().toISOString();
	await dbClient.execute({
		sql: `
			INSERT INTO position_defense_levels (
				symbol,
				side,
				entry_invalidation,
				structure_invalidation,
				entry_breached,
				structure_breached,
				last_forced_decision_at,
				notes,
				updated_at
			) VALUES (?, ?, ?, ?, 0, 0, NULL, ?, ?)
			ON CONFLICT(symbol) DO UPDATE SET
				side = excluded.side,
				entry_invalidation = excluded.entry_invalidation,
				structure_invalidation = excluded.structure_invalidation,
				entry_breached = 0,
				structure_breached = 0,
				last_forced_decision_at = NULL,
				notes = excluded.notes,
				updated_at = excluded.updated_at
		`,
		args: [
			symbol,
			side,
			params.entryInvalidation,
			params.structureInvalidation,
			params.notes ?? null,
			now,
		],
	});
	logger.info(
		`[低频防守点位] ${symbol} (${side}) 已更新：entry=${params.entryInvalidation}, structure=${params.structureInvalidation}`,
	);
}

export async function listDefenseLevels(): Promise<DefenseLevelRecord[]> {
	await ensureDefenseTable();
	const result = await dbClient.execute(
		"SELECT * FROM position_defense_levels",
	);
	return (result.rows as any[]).map((row) => ({
		symbol: row.symbol as string,
		side: normalizeSide(row.side as string),
		entryInvalidation: Number.parseFloat(
			(row.entry_invalidation as string) ?? "0",
		),
		structureInvalidation: Number.parseFloat(
			(row.structure_invalidation as string) ?? "0",
		),
		entryBreached: Number.parseInt(
			(row.entry_breached as string) ?? "0",
			10,
		) === 1,
		structureBreached: Number.parseInt(
			(row.structure_breached as string) ?? "0",
			10,
		) === 1,
		lastForcedDecisionAt: row.last_forced_decision_at as string | null,
		notes: row.notes as string | null,
		updatedAt: row.updated_at as string,
	}));
}

export async function deleteDefenseLevels(symbol: string) {
	await ensureDefenseTable();
	await dbClient.execute({
		sql: "DELETE FROM position_defense_levels WHERE symbol = ?",
		args: [normalizeSymbol(symbol)],
	});
	logger.info(`[低频防守点位] 已移除 ${symbol} 的监控记录。`);
}

export async function resetDefenseBreaches(symbol: string) {
	await ensureDefenseTable();
	await dbClient.execute({
		sql: `
			UPDATE position_defense_levels
			SET entry_breached = 0,
					structure_breached = 0,
					last_forced_decision_at = NULL,
					updated_at = ?
			WHERE symbol = ?
		`,
		args: [new Date().toISOString(), normalizeSymbol(symbol)],
	});
}

export async function markDefenseBreach(
	symbol: string,
	type: DefenseLevelType,
) {
	await ensureDefenseTable();
	const column =
		type === "entry" ? "entry_breached" : "structure_breached";
	await dbClient.execute({
		sql: `
			UPDATE position_defense_levels
			SET ${column} = 1,
					last_forced_decision_at = ?,
					updated_at = ?
			WHERE symbol = ?
		`,
		args: [
			new Date().toISOString(),
			new Date().toISOString(),
			normalizeSymbol(symbol),
		],
	});
}

export async function bulkDeleteMissingSymbols(symbols: Set<string>) {
	await ensureDefenseTable();
	if (!symbols.size) {
		return;
	}
	const placeholders = Array.from({ length: symbols.size }, () => "?").join(
		",",
	);
	await dbClient.execute({
		sql: `DELETE FROM position_defense_levels WHERE symbol NOT IN (${placeholders})`,
		args: Array.from(symbols),
	});
}

export async function getDefenseLevelBySymbol(
	symbol: string,
): Promise<DefenseLevelRecord | null> {
	await ensureDefenseTable();
	const result = await dbClient.execute({
		sql: "SELECT * FROM position_defense_levels WHERE symbol = ? LIMIT 1",
		args: [normalizeSymbol(symbol)],
	});
	if (result.rows.length === 0) {
		return null;
	}
	const row = result.rows[0] as any;
	return {
		symbol: row.symbol as string,
		side: normalizeSide(row.side as string),
		entryInvalidation: Number.parseFloat(
			(row.entry_invalidation as string) ?? "0",
		),
		structureInvalidation: Number.parseFloat(
			(row.structure_invalidation as string) ?? "0",
		),
		entryBreached: Number.parseInt(
			(row.entry_breached as string) ?? "0",
			10,
		) === 1,
		structureBreached: Number.parseInt(
			(row.structure_breached as string) ?? "0",
			10,
		) === 1,
		lastForcedDecisionAt: row.last_forced_decision_at as string | null,
		notes: row.notes as string | null,
		updatedAt: row.updated_at as string,
	};
}
