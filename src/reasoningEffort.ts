import * as vscode from "vscode";

import type { HFModelItem, ReasoningEffort } from "./types";

export const REASONING_EFFORT_CONFIGURATION_KEY = "reasoningEffort";

export const REASONING_EFFORT_ORDER = [
	"max",
	"xhigh",
	"high",
	"medium",
	"low",
	"minimal",
] as const satisfies readonly ReasoningEffort[];

const REASONING_EFFORT_VALUES = new Set<string>(REASONING_EFFORT_ORDER);

const REASONING_EFFORT_METADATA = {
	max: {
		name: "Max",
		description: "Maximum depth of inference",
	},
	xhigh: {
		name: "Extra High",
		description: "Extra high depth of inference",
	},
	high: {
		name: "High",
		description: "High depth of inference",
	},
	medium: {
		name: "Medium",
		description: "Balance thinking with speed",
	},
	low: {
		name: "Low",
		description: "Faster response times and lower depth of inference",
	},
	minimal: {
		name: "Minimal",
		description: "Minimum depth of inference",
	},
} satisfies Record<ReasoningEffort, { name: string; description: string }>;

export function buildReasoningEffortConfigurationSchema(
	model: HFModelItem
): vscode.LanguageModelConfigurationSchema | undefined {
	if (!isReasoningEffortConfigurable(model)) {
		return undefined;
	}

	const supportedEfforts = resolveSupportedReasoningEfforts(model);
	const defaultEffort = resolveDefaultReasoningEffort(model, supportedEfforts);

	return {
		properties: {
			[REASONING_EFFORT_CONFIGURATION_KEY]: {
				type: "string",
				title: "Reasoning Effort",
				enum: supportedEfforts,
				enumItemLabels: supportedEfforts.map((effort) => REASONING_EFFORT_METADATA[effort].name),
				enumDescriptions: supportedEfforts.map((effort) => REASONING_EFFORT_METADATA[effort].description),
				default: defaultEffort,
				group: "navigation",
			},
		},
	};
}

export function applyReasoningEffortSelection(
	model: HFModelItem | undefined,
	modelConfiguration: unknown
): HFModelItem | undefined {
	if (!model || !isReasoningEffortConfigurable(model)) {
		return model;
	}

	const supportedEfforts = resolveSupportedReasoningEfforts(model);
	const configuredEffort = getConfiguredReasoningEffort(modelConfiguration);
	const resolvedEffort =
		configuredEffort && supportedEfforts.includes(configuredEffort)
			? configuredEffort
			: resolveDefaultReasoningEffort(model, supportedEfforts);

	if (model.reasoning_effort === resolvedEffort) {
		return model;
	}

	return {
		...model,
		reasoning_effort: resolvedEffort,
	};
}

function isReasoningEffortConfigurable(model: HFModelItem): boolean {
	return model.reasoning_effort_configurable === true;
}

function resolveSupportedReasoningEfforts(model: HFModelItem): readonly ReasoningEffort[] {
	if (Array.isArray(model.reasoning_effort_supported) && model.reasoning_effort_supported.length > 0) {
		const supported = REASONING_EFFORT_ORDER.filter((effort) => model.reasoning_effort_supported?.includes(effort));
		if (supported.length > 0) {
			return supported;
		}
	}

	return REASONING_EFFORT_ORDER;
}

function resolveDefaultReasoningEffort(
	model: HFModelItem,
	supportedEfforts: readonly ReasoningEffort[]
): ReasoningEffort {
	const candidates: unknown[] = [model.reasoning_effort_default, model.reasoning_effort, "medium"];
	for (const candidate of candidates) {
		if (isReasoningEffort(candidate) && supportedEfforts.includes(candidate)) {
			return candidate;
		}
	}

	return supportedEfforts[0] ?? "medium";
}

function getConfiguredReasoningEffort(modelConfiguration: unknown): ReasoningEffort | undefined {
	if (!modelConfiguration || typeof modelConfiguration !== "object" || Array.isArray(modelConfiguration)) {
		return undefined;
	}

	const value = (modelConfiguration as Record<string, unknown>)[REASONING_EFFORT_CONFIGURATION_KEY];
	return isReasoningEffort(value) ? value : undefined;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
	return typeof value === "string" && REASONING_EFFORT_VALUES.has(value);
}
