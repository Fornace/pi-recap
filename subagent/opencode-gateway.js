/**
 * Quirks of the opencode gateways (opencode.ai/zen and .../zen/go) that a direct
 * stream() has to handle itself:
 *
 *  - the gateways require an x-opencode-session routing header, which pi injects
 *    only on its own session calls, so a direct stream gets HTTP 400
 *    MissingSessionID without it;
 *  - they default to reasoning ON, and pi-ai only emits an off-control when the
 *    catalog carries a string thinkingLevelMap.off, which these models lack.
 *
 * Both facts gate on the same host predicate, which is why they live together.
 */
import { randomUUID } from "node:crypto";
/**
 * The opencode gateways need a routing session id, and only they accept the
 * `thinking` request field. Both facts gate on the same predicate.
 */
export function isOpencodeGateway(model) {
    if (model.provider === "opencode" || model.provider === "opencode-go")
        return true;
    try {
        return new URL(model.baseUrl ?? "").hostname === "opencode.ai";
    }
    catch {
        return false;
    }
}
// Stable per-process routing id for the opencode gateways. pi normally injects
// x-opencode-session itself, but only on its own session calls; a direct
// stream() without it gets HTTP 400 MissingSessionID from opencode.ai/zen/go.
const RECAP_SESSION_ID = `pi-recap-${randomUUID()}`;
/**
 * Attach the request headers a direct stream() needs but pi's session path
 * adds for us. Currently: opencode / opencode-go routing affinity.
 */
export function recapRequestHeaders(model, headers) {
    const merged = { ...(headers ?? {}) };
    if (isOpencodeGateway(model)) {
        merged["x-opencode-session"] = RECAP_SESSION_ID;
        merged["x-opencode-client"] = "pi";
    }
    return merged;
}
export function thinkingOffOpts(model) {
    switch (model.api) {
        case "anthropic-messages":
            return { thinkingEnabled: false };
        case "google-generative-ai":
        case "google-vertex":
            return { thinking: { enabled: false } };
        default:
            // OpenAI-compatible gateways: pi-ai only emits an off-control when the
            // catalog carries a string thinkingLevelMap.off. These models have
            // `off: null` (or no map at all), so with `{}` the server default applies
            // -- and the opencode gateways default to reasoning ON, which burns most
            // of the tiny recap maxTokens budget on thinking. Force it off via
            // samplingParams (StreamOptions), which merges last and overrides the
            // named request fields. Scoped to opencode hosts: `thinking` is not a
            // portable field.
            return isOpencodeGateway(model) ? { samplingParams: { thinking: { type: "disabled" } } } : {};
    }
}
