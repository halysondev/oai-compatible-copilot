import * as assert from "assert";

import {
	applyReasoningEffortSelection,
	buildReasoningEffortConfigurationSchema,
} from "../reasoningEffort";
import type { HFModelItem } from "../types";

suite("reasoningEffort", () => {
	const baseModel: HFModelItem = {
		id: "gpt-5.1",
		owned_by: "openai",
	};

	test("does not build schema when selector is not enabled", () => {
		assert.strictEqual(buildReasoningEffortConfigurationSchema(baseModel), undefined);
	});

	test("builds navigation schema with canonical values and default", () => {
		const schema = buildReasoningEffortConfigurationSchema({
			...baseModel,
			reasoning_effort_configurable: true,
			reasoning_effort: "high",
		});

		const reasoningEffort = schema?.properties?.reasoningEffort;
		assert.ok(reasoningEffort);
		assert.deepStrictEqual(reasoningEffort.enum, ["max", "xhigh", "high", "medium", "low", "minimal"]);
		assert.deepStrictEqual(reasoningEffort.enumItemLabels, [
			"Max",
			"Extra High",
			"High",
			"Medium",
			"Low",
			"Minimal",
		]);
		assert.strictEqual(reasoningEffort.default, "high");
		assert.strictEqual(reasoningEffort.group, "navigation");
	});

	test("filters supported efforts and preserves canonical order", () => {
		const schema = buildReasoningEffortConfigurationSchema({
			...baseModel,
			reasoning_effort_configurable: true,
			reasoning_effort_default: "low",
			reasoning_effort_supported: ["low", "high", "medium"],
		});

		const reasoningEffort = schema?.properties?.reasoningEffort;
		assert.deepStrictEqual(reasoningEffort?.enum, ["high", "medium", "low"]);
		assert.strictEqual(reasoningEffort?.default, "low");
	});

	test("falls back to first supported effort when default is unsupported", () => {
		const schema = buildReasoningEffortConfigurationSchema({
			...baseModel,
			reasoning_effort_configurable: true,
			reasoning_effort_default: "minimal",
			reasoning_effort: "medium",
			reasoning_effort_supported: ["high", "low"],
		});

		const reasoningEffort = schema?.properties?.reasoningEffort;
		assert.deepStrictEqual(reasoningEffort?.enum, ["high", "low"]);
		assert.strictEqual(reasoningEffort?.default, "high");
	});

	test("applies selected reasoning effort without mutating original model", () => {
		const model: HFModelItem = {
			...baseModel,
			reasoning_effort_configurable: true,
			reasoning_effort: "medium",
			reasoning_effort_supported: ["high", "medium", "low"],
		};

		const resolved = applyReasoningEffortSelection(model, { reasoningEffort: "low" });

		assert.notStrictEqual(resolved, model);
		assert.strictEqual(resolved?.reasoning_effort, "low");
		assert.strictEqual(model.reasoning_effort, "medium");
	});

	test("uses default effort when selection is absent or invalid", () => {
		const model: HFModelItem = {
			...baseModel,
			reasoning_effort_configurable: true,
			reasoning_effort_default: "low",
			reasoning_effort_supported: ["high", "medium", "low"],
		};

		assert.strictEqual(applyReasoningEffortSelection(model, undefined)?.reasoning_effort, "low");
		assert.strictEqual(applyReasoningEffortSelection(model, { reasoningEffort: "minimal" })?.reasoning_effort, "low");
	});

	test("ignores model configuration when selector is disabled", () => {
		const model: HFModelItem = {
			...baseModel,
			reasoning_effort: "medium",
		};

		const resolved = applyReasoningEffortSelection(model, { reasoningEffort: "high" });

		assert.strictEqual(resolved, model);
		assert.strictEqual(resolved?.reasoning_effort, "medium");
	});
});
