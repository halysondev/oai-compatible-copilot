import * as assert from "assert";

import { fetchModels } from "../provideModel";
import { buildOpenAICompatibleUrl } from "../urlUtils";

suite("urlUtils", () => {
	test("appends configured query params to common OpenAI-compatible endpoints", () => {
		const queryParams = { "api-version": "2025-04-01-preview" };
		const baseUrl = "https://deployment.openai.azure.com/openai/";

		assert.strictEqual(
			buildOpenAICompatibleUrl(baseUrl, "/models", queryParams),
			"https://deployment.openai.azure.com/openai/models?api-version=2025-04-01-preview"
		);
		assert.strictEqual(
			buildOpenAICompatibleUrl(baseUrl, "/chat/completions", queryParams),
			"https://deployment.openai.azure.com/openai/chat/completions?api-version=2025-04-01-preview"
		);
		assert.strictEqual(
			buildOpenAICompatibleUrl(baseUrl, "/responses", queryParams),
			"https://deployment.openai.azure.com/openai/responses?api-version=2025-04-01-preview"
		);
	});

	test("treats base URLs with and without trailing slash the same", () => {
		const queryParams = { "api-version": "2025-04-01-preview" };
		const withSlash = buildOpenAICompatibleUrl("https://deployment.openai.azure.com/openai/", "/models", queryParams);
		const withoutSlash = buildOpenAICompatibleUrl("https://deployment.openai.azure.com/openai", "/models", queryParams);

		assert.strictEqual(withSlash, withoutSlash);
	});

	test("preserves base URL query params and lets configured query params override matching keys", () => {
		const url = new URL(
			buildOpenAICompatibleUrl("https://deployment.openai.azure.com/openai/?deployment=foo&api-version=2024-12-01", "/models", {
				"api-version": "2025-04-01-preview",
				region: "eastus",
			})
		);

		assert.strictEqual(url.pathname, "/openai/models");
		assert.strictEqual(url.searchParams.get("deployment"), "foo");
		assert.strictEqual(url.searchParams.get("api-version"), "2025-04-01-preview");
		assert.strictEqual(url.searchParams.get("region"), "eastus");
	});

	test("lets endpoint-owned query params override both base URL and configured query params", () => {
		const url = new URL(
			buildOpenAICompatibleUrl(
				"https://deployment.openai.azure.com/openai/?api-version=2024-12-01&alt=json",
				"/responses",
				{ "api-version": "2025-04-01-preview", alt: "compact" },
				{ alt: "sse" }
			)
		);

		assert.strictEqual(url.pathname, "/openai/responses");
		assert.strictEqual(url.searchParams.get("api-version"), "2025-04-01-preview");
		assert.strictEqual(url.searchParams.get("alt"), "sse");
	});

	test("fetchModels only applies query params for openai-compatible modes", async () => {
		const originalFetch = globalThis.fetch;
		const requestedUrls: string[] = [];

		try {
			globalThis.fetch = (async (input: string | URL | Request) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				requestedUrls.push(url);
				return new Response(JSON.stringify({ object: "list", data: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}) as typeof globalThis.fetch;

			await fetchModels(
				"https://deployment.openai.azure.com/openai/",
				"test-key",
				"openai",
				undefined,
				{ "api-version": "2025-04-01-preview" }
			);
			await fetchModels(
				"https://deployment.openai.azure.com/openai/",
				"test-key",
				"openai-responses",
				undefined,
				{ "api-version": "2025-04-01-preview" }
			);
			await fetchModels(
				"https://api.anthropic.com",
				"test-key",
				"anthropic",
				undefined,
				{ "api-version": "2025-04-01-preview" }
			);
		} finally {
			globalThis.fetch = originalFetch;
		}

		assert.strictEqual(
			requestedUrls[0],
			"https://deployment.openai.azure.com/openai/models?api-version=2025-04-01-preview"
		);
		assert.strictEqual(
			requestedUrls[1],
			"https://deployment.openai.azure.com/openai/models?api-version=2025-04-01-preview"
		);
		assert.strictEqual(requestedUrls[2], "https://api.anthropic.com/models");
	});
});
