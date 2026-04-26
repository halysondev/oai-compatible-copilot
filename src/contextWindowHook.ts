/**
 * Context Window Hook - Inject usage data into VS Code's context window widget.
 *
 * VS Code's LanguageModelChatProvider API does not expose token usage reporting.
 * Copilot Chat later writes a zero-usage chunk for third-party providers, so this
 * hook captures the internal chat agents proxy and rewrites usage chunks for
 * requests served by this extension.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as vscode from "vscode";

export const CONTEXT_WINDOW_FIX_CONFIG_KEY = "oaicopilot.fixes.ContextIndicatorDisplay";
export const DEFAULT_CONTEXT_WINDOW_FIX_ENABLED = true;

export type ProviderUsage = Record<string, unknown>;

type HandleProgressChunkFn = (requestId: string, chunks: unknown[]) => Promise<void>;

interface CapturedProxy {
	proxyTarget: Record<string, unknown>;
	originalHandleProgressChunk: HandleProgressChunkFn;
}

interface ContextWindowUsage {
	promptTokens: number;
	completionTokens: number;
	outputBuffer?: number;
}

type SetAddFn = typeof Set.prototype.add;
type SetDeleteFn = typeof Set.prototype.delete;

let originalHandleProgressChunk: HandleProgressChunkFn | null = null;
let proxyTarget: Record<string, unknown> | null = null;

const inFlightRequestIds = new Map<string, true>();
const localToVsCodeRequestIds = new Map<string, string>();
const vsCodeToLocalRequestIds = new Map<string, string>();
const pendingUsage = new Map<string, ContextWindowUsage>();
const pendingUsageByLocalRequestId = new Map<string, ContextWindowUsage>();
const outputBuffersByLocalRequestId = new Map<string, number>();

const requestContextStorage = new AsyncLocalStorage<string>();
const queuedProgressLocalRequestIds: string[] = [];
const queuedProgressLocalRequestIdSet = new Set<string>();

let patchedHandleProgressChunk: HandleProgressChunkFn | null = null;
let originalSetAdd: SetAddFn | null = null;
let originalSetDelete: SetDeleteFn | null = null;
let patchedSetAdd: SetAddFn | null = null;
let patchedSetDelete: SetDeleteFn | null = null;
let requestTrackingInstalled = false;
let hookInstalled = false;
let initializationGeneration = 0;

function isContextIndicatorDisplayFixEnabled(): boolean {
	const config = vscode.workspace.getConfiguration();
	return config.get<boolean>(CONTEXT_WINDOW_FIX_CONFIG_KEY, DEFAULT_CONTEXT_WINDOW_FIX_ENABLED);
}

function createUsageChunk(usage: ContextWindowUsage): {
	kind: "usage";
	promptTokens: number;
	completionTokens: number;
	outputBuffer?: number;
} {
	return {
		kind: "usage",
		promptTokens: usage.promptTokens,
		completionTokens: usage.completionTokens,
		...(usage.outputBuffer !== undefined ? { outputBuffer: usage.outputBuffer } : {}),
	};
}

function queueProgressBinding(localRequestId: string): void {
	if (localToVsCodeRequestIds.has(localRequestId) || queuedProgressLocalRequestIdSet.has(localRequestId)) {
		return;
	}

	queuedProgressLocalRequestIds.push(localRequestId);
	queuedProgressLocalRequestIdSet.add(localRequestId);
}

function discardQueuedProgressBinding(localRequestId: string): void {
	queuedProgressLocalRequestIdSet.delete(localRequestId);
}

function takeQueuedProgressBinding(): string | undefined {
	while (queuedProgressLocalRequestIds.length > 0) {
		const localRequestId = queuedProgressLocalRequestIds.shift();
		if (!localRequestId) {
			continue;
		}
		if (!queuedProgressLocalRequestIdSet.delete(localRequestId)) {
			continue;
		}
		if (!localToVsCodeRequestIds.has(localRequestId)) {
			return localRequestId;
		}
	}

	return undefined;
}

function injectUsageChunk(requestId: string, usage: ContextWindowUsage): void {
	if (!proxyTarget || !originalHandleProgressChunk) {
		return;
	}

	originalHandleProgressChunk.call(proxyTarget, requestId, [createUsageChunk(usage)]).catch(() => {
		// Ignore best-effort internal usage injection failures.
	});
}

function bindLocalRequestToVsCodeRequest(localRequestId: string, requestId: string): void {
	discardQueuedProgressBinding(localRequestId);

	const previousRequestId = localToVsCodeRequestIds.get(localRequestId);
	if (previousRequestId && previousRequestId !== requestId) {
		vsCodeToLocalRequestIds.delete(previousRequestId);
		pendingUsage.delete(previousRequestId);
	}

	const previousLocalRequestId = vsCodeToLocalRequestIds.get(requestId);
	if (previousLocalRequestId && previousLocalRequestId !== localRequestId) {
		localToVsCodeRequestIds.delete(previousLocalRequestId);
		pendingUsageByLocalRequestId.delete(previousLocalRequestId);
		outputBuffersByLocalRequestId.delete(previousLocalRequestId);
	}

	localToVsCodeRequestIds.set(localRequestId, requestId);
	vsCodeToLocalRequestIds.set(requestId, localRequestId);

	const pendingLocalUsage = pendingUsageByLocalRequestId.get(localRequestId);
	if (pendingLocalUsage) {
		pendingUsage.set(requestId, pendingLocalUsage);
		pendingUsageByLocalRequestId.delete(localRequestId);
		injectUsageChunk(requestId, pendingLocalUsage);
	}
}

function cleanupVsCodeRequest(requestId: string): void {
	inFlightRequestIds.delete(requestId);
	pendingUsage.delete(requestId);

	const localRequestId = vsCodeToLocalRequestIds.get(requestId);
	if (!localRequestId) {
		return;
	}

	vsCodeToLocalRequestIds.delete(requestId);
	const mappedRequestId = localToVsCodeRequestIds.get(localRequestId);
	if (mappedRequestId === requestId) {
		localToVsCodeRequestIds.delete(localRequestId);
	}
	outputBuffersByLocalRequestId.delete(localRequestId);
}

async function captureProxy(): Promise<CapturedProxy | null> {
	const originalMapSet = Map.prototype.set;
	const probeId = `_oaicopilot_probe_${Date.now()}`;
	let found = false;
	let capturedProxyTarget: Record<string, unknown> | null = null;
	let capturedHandleProgressChunk: HandleProgressChunkFn | null = null;

	Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
		if (!found && typeof value === "object" && value !== null) {
			const v = value as Record<string, unknown>;
			const candidate = v._proxy as Record<string, unknown> | undefined;
			if (
				candidate &&
				typeof candidate.$handleProgressChunk === "function" &&
				(v.id === probeId || v.label === probeId || v.name === probeId)
			) {
				capturedProxyTarget = candidate;
				capturedHandleProgressChunk = candidate.$handleProgressChunk as HandleProgressChunkFn;
				found = true;
			}
		}
		return originalMapSet.call(this, key, value);
	};

	let temp: vscode.ChatParticipant | undefined;
	try {
		temp = vscode.chat.createChatParticipant(probeId, () => Promise.resolve());
		await new Promise((resolve) => setTimeout(resolve, 150));
	} catch {
		// Silently leave the hook disabled when internals are unavailable.
	} finally {
		if (temp) {
			temp.dispose();
		}
		Map.prototype.set = originalMapSet;
	}

	if (!found || !capturedProxyTarget || !capturedHandleProgressChunk) {
		return null;
	}

	return {
		proxyTarget: capturedProxyTarget,
		originalHandleProgressChunk: capturedHandleProgressChunk,
	};
}

function patchProxy(captured: CapturedProxy): void {
	if (hookInstalled) {
		return;
	}

	const target = captured.proxyTarget;
	const original = captured.originalHandleProgressChunk;
	const patched: HandleProgressChunkFn = function (requestId: string, chunks: unknown[]): Promise<void> {
		let localRequestId = requestContextStorage.getStore();
		if (!localRequestId && !vsCodeToLocalRequestIds.has(requestId)) {
			localRequestId = takeQueuedProgressBinding();
		}
		if (localRequestId) {
			bindLocalRequestToVsCodeRequest(localRequestId, requestId);
		}

		const stored = pendingUsage.get(requestId);
		if (stored) {
			for (const raw of chunks) {
				const chunk = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
				if (chunk && chunk.kind === "usage") {
					chunk.promptTokens = stored.promptTokens;
					chunk.completionTokens = stored.completionTokens;
					if (stored.outputBuffer !== undefined) {
						chunk.outputBuffer = stored.outputBuffer;
					}
				}
			}
		}
		return original.call(target, requestId, chunks);
	};

	proxyTarget = target;
	originalHandleProgressChunk = original;
	patchedHandleProgressChunk = patched;
	target.$handleProgressChunk = patched;
	hookInstalled = true;
}

function unpatchProxy(): void {
	if (
		proxyTarget &&
		originalHandleProgressChunk &&
		patchedHandleProgressChunk &&
		proxyTarget.$handleProgressChunk === patchedHandleProgressChunk
	) {
		proxyTarget.$handleProgressChunk = originalHandleProgressChunk;
	}

	patchedHandleProgressChunk = null;
	originalHandleProgressChunk = null;
	proxyTarget = null;
	hookInstalled = false;
}

function installRequestTracking(): void {
	if (requestTrackingInstalled) {
		return;
	}

	const capturedOriginalAdd = Set.prototype.add;
	const capturedOriginalDelete = Set.prototype.delete;

	const nextPatchedAdd: SetAddFn = function <T>(this: Set<T>, value: T): Set<T> {
		if (typeof value === "object" && value !== null) {
			const v = value as Record<string, unknown>;
			if (typeof v.requestId === "string" && "extRequest" in v) {
				inFlightRequestIds.set(v.requestId, true);
			}
		}
		return capturedOriginalAdd.call(this, value);
	};

	const nextPatchedDelete: SetDeleteFn = function <T>(this: Set<T>, value: T): boolean {
		if (typeof value === "object" && value !== null) {
			const v = value as Record<string, unknown>;
			if (typeof v.requestId === "string" && "extRequest" in v) {
				cleanupVsCodeRequest(v.requestId);
			}
		}
		return capturedOriginalDelete.call(this, value);
	};

	originalSetAdd = capturedOriginalAdd;
	originalSetDelete = capturedOriginalDelete;
	patchedSetAdd = nextPatchedAdd;
	patchedSetDelete = nextPatchedDelete;
	Set.prototype.add = nextPatchedAdd;
	Set.prototype.delete = nextPatchedDelete;
	requestTrackingInstalled = true;
}

function uninstallRequestTracking(): void {
	if (patchedSetAdd && originalSetAdd && Set.prototype.add === patchedSetAdd) {
		Set.prototype.add = originalSetAdd;
	}
	if (patchedSetDelete && originalSetDelete && Set.prototype.delete === patchedSetDelete) {
		Set.prototype.delete = originalSetDelete;
	}

	patchedSetAdd = null;
	patchedSetDelete = null;
	originalSetAdd = null;
	originalSetDelete = null;
	requestTrackingInstalled = false;
}

function readNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function normalizeUsage(usage: ProviderUsage): ContextWindowUsage | null {
	try {
		if (
			"input_tokens" in usage &&
			"output_tokens" in usage &&
			"input_tokens_details" in usage &&
			"total_tokens" in usage
		) {
			return {
				promptTokens: readNumber(usage.input_tokens),
				completionTokens: readNumber(usage.output_tokens),
			};
		}

		if (
			"input_tokens" in usage &&
			"output_tokens" in usage &&
			!("input_tokens_details" in usage) &&
			!("total_tokens" in usage) &&
			!("promptTokenCount" in usage)
		) {
			return {
				promptTokens:
					readNumber(usage.input_tokens) +
					readNumber(usage.cache_read_input_tokens) +
					readNumber(usage.cache_creation_input_tokens),
				completionTokens: readNumber(usage.output_tokens),
			};
		}

		if ("prompt_tokens" in usage && "completion_tokens" in usage) {
			return {
				promptTokens: readNumber(usage.prompt_tokens),
				completionTokens: readNumber(usage.completion_tokens),
			};
		}

		if ("promptTokenCount" in usage) {
			return {
				promptTokens: readNumber(usage.promptTokenCount),
				completionTokens: readNumber(usage.candidatesTokenCount),
			};
		}

		if ("prompt_eval_count" in usage) {
			return {
				promptTokens: readNumber(usage.prompt_eval_count),
				completionTokens: readNumber(usage.eval_count),
			};
		}
	} catch {
		return null;
	}

	return null;
}

function normalizeOutputBuffer(outputBuffer: number): number | undefined {
	if (!Number.isFinite(outputBuffer) || outputBuffer <= 0) {
		return undefined;
	}

	return Math.floor(outputBuffer);
}

function withOutputBuffer(localRequestId: string, usage: ContextWindowUsage): ContextWindowUsage {
	const outputBuffer = outputBuffersByLocalRequestId.get(localRequestId);
	return outputBuffer !== undefined ? { ...usage, outputBuffer } : usage;
}

export function reportUsageToContextWindow(usage: ProviderUsage): boolean {
	const localRequestId = requestContextStorage.getStore();
	if (!localRequestId) {
		return false;
	}

	return reportUsageToContextWindowForRequest(localRequestId, usage);
}

export function reportUsageToContextWindowForRequest(localRequestId: string, usage: ProviderUsage): boolean {
	if (!isContextIndicatorDisplayFixEnabled()) {
		return false;
	}

	const normalized = normalizeUsage(usage);
	if (!normalized || (normalized.promptTokens === 0 && normalized.completionTokens === 0)) {
		return false;
	}

	if (!proxyTarget || !originalHandleProgressChunk) {
		return false;
	}

	const usageWithOutputBuffer = withOutputBuffer(localRequestId, normalized);
	const requestId = localToVsCodeRequestIds.get(localRequestId);
	if (!requestId) {
		pendingUsageByLocalRequestId.set(localRequestId, usageWithOutputBuffer);
		return false;
	}

	pendingUsage.set(requestId, usageWithOutputBuffer);
	injectUsageChunk(requestId, usageWithOutputBuffer);
	return true;
}

export function setContextWindowOutputBufferForRequest(localRequestId: string, outputBuffer: number): void {
	if (!isContextIndicatorDisplayFixEnabled()) {
		return;
	}

	const normalizedOutputBuffer = normalizeOutputBuffer(outputBuffer);
	if (normalizedOutputBuffer === undefined) {
		outputBuffersByLocalRequestId.delete(localRequestId);
		return;
	}

	outputBuffersByLocalRequestId.set(localRequestId, normalizedOutputBuffer);

	const pendingLocalUsage = pendingUsageByLocalRequestId.get(localRequestId);
	if (pendingLocalUsage) {
		pendingUsageByLocalRequestId.set(localRequestId, {
			...pendingLocalUsage,
			outputBuffer: normalizedOutputBuffer,
		});
	}

	const requestId = localToVsCodeRequestIds.get(localRequestId);
	if (!requestId) {
		return;
	}

	const pendingRequestUsage = pendingUsage.get(requestId);
	if (pendingRequestUsage) {
		pendingUsage.set(requestId, {
			...pendingRequestUsage,
			outputBuffer: normalizedOutputBuffer,
		});
	}
}

export function withContextWindowRequest<T>(localRequestId: string, fn: () => T): T {
	return requestContextStorage.run(localRequestId, fn);
}

export function reportProgressWithContextWindowRequest(
	localRequestId: string,
	progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
	part: vscode.LanguageModelResponsePart2
): void {
	queueProgressBinding(localRequestId);
	withContextWindowRequest(localRequestId, () => {
		progress.report(part);
	});
}

export function clearContextWindowRequest(localRequestId: string): void {
	discardQueuedProgressBinding(localRequestId);
	pendingUsageByLocalRequestId.delete(localRequestId);
	outputBuffersByLocalRequestId.delete(localRequestId);
}

export function disposeContextWindowHook(): boolean {
	const hadState =
		hookInstalled ||
		requestTrackingInstalled ||
		inFlightRequestIds.size > 0 ||
		pendingUsage.size > 0 ||
		pendingUsageByLocalRequestId.size > 0 ||
		outputBuffersByLocalRequestId.size > 0 ||
		localToVsCodeRequestIds.size > 0 ||
		vsCodeToLocalRequestIds.size > 0 ||
		queuedProgressLocalRequestIdSet.size > 0;

	initializationGeneration += 1;
	unpatchProxy();
	uninstallRequestTracking();
	inFlightRequestIds.clear();
	pendingUsage.clear();
	pendingUsageByLocalRequestId.clear();
	outputBuffersByLocalRequestId.clear();
	localToVsCodeRequestIds.clear();
	vsCodeToLocalRequestIds.clear();
	queuedProgressLocalRequestIds.length = 0;
	queuedProgressLocalRequestIdSet.clear();

	return hadState;
}

export async function initializeContextWindowHook(): Promise<boolean> {
	if (!isContextIndicatorDisplayFixEnabled()) {
		return false;
	}

	if (hookInstalled) {
		return true;
	}

	const generation = ++initializationGeneration;

	installRequestTracking();
	const captured = await captureProxy();

	if (generation !== initializationGeneration || !isContextIndicatorDisplayFixEnabled()) {
		return false;
	}

	if (captured) {
		patchProxy(captured);
		console.log("[ContextWindowHook] Proxy captured and patched successfully");
	} else {
		uninstallRequestTracking();
		inFlightRequestIds.clear();
		pendingUsage.clear();
		console.log("[ContextWindowHook] Failed to capture proxy - usage injection disabled");
	}

	return captured !== null;
}
