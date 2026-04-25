export type QueryParams = Record<string, string>;

function mergeQueryParams(
	searchParams: URLSearchParams,
	queryParams?: QueryParams,
	endpointQueryParams?: QueryParams
): URLSearchParams {
	const merged = new URLSearchParams(searchParams);

	for (const [key, value] of Object.entries(queryParams ?? {})) {
		if (typeof value === "string") {
			merged.set(key, value);
		}
	}

	for (const [key, value] of Object.entries(endpointQueryParams ?? {})) {
		if (typeof value === "string") {
			merged.set(key, value);
		}
	}

	return merged;
}

export function buildOpenAICompatibleUrl(
	baseUrl: string,
	endpointPath: string,
	queryParams?: QueryParams,
	endpointQueryParams?: QueryParams
): string {
	const url = new URL(baseUrl);
	const trimmedEndpointPath = (endpointPath || "").trim();
	const normalizedEndpointPath =
		trimmedEndpointPath.length === 0 ? "" : trimmedEndpointPath.startsWith("/") ? trimmedEndpointPath : `/${trimmedEndpointPath}`;
	const basePath = (url.pathname || "").replace(/\/+$/, "");

	url.pathname = `${basePath}${normalizedEndpointPath}` || "/";
	url.search = mergeQueryParams(url.searchParams, queryParams, endpointQueryParams).toString();
	url.hash = "";

	return url.toString();
}
