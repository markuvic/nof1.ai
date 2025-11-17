/**
 * Agent Profile 工具方法
 */

const normalizeRegex = /[\s_]+/g;

export const LOW_FREQUENCY_PROFILE_ALIASES = [
	"low-frequency",
	"lowfreq",
	"low-frequency-agent",
	"swing",
	"swing-agent",
];

export const MID_FREQUENCY_PROFILE_ALIASES = [
	"mid-frequency",
	"midfreq",
	"mid-frequency-agent",
];

export const NAKED_K_PROFILE_ALIASES = [
	"naked-k",
	"nakedk",
	"naked",
];

export const HYBRID_PROFILE_ALIASES = [
	"hybrid",
	"hybrid-agent",
	"hybrid-autonomous",
	"hybrid-autonomous-agent",
	"hybridautonomous",
	"hybridagent",
];

export const QUANT_HYBRID_PROFILE_ALIASES = [
	"quant-hybrid",
	"hybrid-quant",
	"quant",
	"quant-agent",
];

export const QUANT_HYBRID_NO_IMAGE_ALIASES = [
	"quant-hybrid-no-image",
	"hybrid-quant-no-image",
];

export function normalizeAgentProfile(raw?: string | null): string {
	if (!raw) {
		return "default";
	}
	return raw.trim().toLowerCase().replace(normalizeRegex, "-");
}

export function profileMatches(
	normalizedProfile: string,
	aliases: readonly string[],
): boolean {
	return aliases.includes(normalizedProfile);
}

export function isLowFrequencyAgentProfile(raw?: string | null): boolean {
	return profileMatches(
		normalizeAgentProfile(raw),
		LOW_FREQUENCY_PROFILE_ALIASES,
	);
}

export function isMidFrequencyAgentProfile(raw?: string | null): boolean {
	return profileMatches(
		normalizeAgentProfile(raw),
		MID_FREQUENCY_PROFILE_ALIASES,
	);
}
