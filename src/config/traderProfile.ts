import os from "node:os";

export type TraderIdentity = {
	traderName: string;
	agentProfile: string;
	exchangeProvider: string;
	port: number;
	isDryRun: boolean;
};

function buildDefaultName() {
	const explicitName = process.env.TRADER_NAME?.trim();
	if (explicitName) {
		return explicitName;
	}

	const profile = process.env.AI_AGENT_PROFILE?.trim();
	if (profile) {
		return profile;
	}

	const hostname = os.hostname();
	const port = process.env.PORT ?? "3141";
	return `${hostname}:${port}`;
}

export function getTraderIdentity(): TraderIdentity {
	const traderName = buildDefaultName();
	const agentProfile = process.env.AI_AGENT_PROFILE?.trim() || "default";
	const exchangeProvider = (process.env.EXCHANGE_PROVIDER || "gate").trim();
	const port = Number.parseInt(process.env.PORT || "3141", 10);
	const isDryRun =
		process.env.EXCHANGE_DRY_RUN === "true" ||
		process.env.DRY_RUN === "true" ||
		process.env.DRY_RUN_MODE === "true";

	return {
		traderName,
		agentProfile,
		exchangeProvider,
		port,
		isDryRun,
	};
}
