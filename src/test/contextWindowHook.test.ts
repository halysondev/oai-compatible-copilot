import * as assert from "assert";

import { normalizeUsage } from "../contextWindowHook";

suite("contextWindowHook", () => {
	test("normalizes OpenAI chat completions usage", () => {
		assert.deepStrictEqual(
			normalizeUsage({
				prompt_tokens: 10,
				completion_tokens: 5,
				total_tokens: 15,
			}),
			{ promptTokens: 10, completionTokens: 5 }
		);
	});

	test("normalizes OpenAI responses usage", () => {
		assert.deepStrictEqual(
			normalizeUsage({
				input_tokens: 20,
				output_tokens: 7,
				input_tokens_details: { cached_tokens: 4 },
				total_tokens: 27,
			}),
			{ promptTokens: 20, completionTokens: 7 }
		);
	});

	test("normalizes Anthropic usage with cache tokens", () => {
		assert.deepStrictEqual(
			normalizeUsage({
				input_tokens: 8,
				output_tokens: 3,
				cache_read_input_tokens: 4,
				cache_creation_input_tokens: 2,
			}),
			{ promptTokens: 14, completionTokens: 3 }
		);
	});

	test("normalizes Gemini usage", () => {
		assert.deepStrictEqual(
			normalizeUsage({
				promptTokenCount: 11,
				candidatesTokenCount: 6,
			}),
			{ promptTokens: 11, completionTokens: 6 }
		);
	});

	test("normalizes Ollama usage", () => {
		assert.deepStrictEqual(
			normalizeUsage({
				prompt_eval_count: 9,
				eval_count: 4,
			}),
			{ promptTokens: 9, completionTokens: 4 }
		);
	});
});
