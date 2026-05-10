/**
 * Test script: call recap prompt with different models, dump raw responses.
 * Run from extension dir: npx jiti test-recap-models.ts
 */

import { complete } from "@earendil-works/pi-ai";

const SYSTEM_PROMPT = `You are a concise session summarizer. Analyze the conversation and return ONLY a JSON object. No markdown fences, no explanation, no other text. Structure: {"recap":"what happened, max 100 chars","goal":"session goal if changed","status":"where things stand, max 80 chars"}. Respond in ENGLISH regardless of conversation language.`;

const TEST_CONVERSATION = [
	{
		role: "user" as const,
		content: [{ type: "text" as const, text: "Can you help me fix the status overlay extension? It's not showing anything." }],
		timestamp: Date.now(),
	},
	{
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "Sure, let me check the extension code. It looks like the widget is hidden because there's no initial state. The recap generation might also be failing silently." }],
		api: "openai-completions" as const,
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop" as const,
		timestamp: Date.now(),
	},
];

const context = {
	systemPrompt: SYSTEM_PROMPT,
	messages: TEST_CONVERSATION,
};

async function testModel(modelId: string, apiKey: string, baseUrl: string, providerLabel: string) {
	const model = {
		id: modelId,
		name: modelId,
		api: "openai-completions" as const,
		provider: providerLabel,
		baseUrl,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 256,
	};

	console.log(`\n=== ${providerLabel}: ${modelId} ===`);
	console.log(`URL: ${baseUrl}`);

	try {
		const response = await complete(model, context, {
			apiKey,
			maxTokens: 256,
			temperature: 0,
		});

		const textParts = response.content.filter((c): c is { type: "text"; text: string } => c.type === "text");
		const rawText = textParts.map((p) => p.text).join("");

		console.log(`\n--- RAW RESPONSE (${rawText.length} chars) ---`);
		console.log(rawText);
		console.log("--- END RAW ---");

		// Show what the current extraction would produce
		const firstBrace = rawText.indexOf("{");
		const lastBrace = rawText.lastIndexOf("}");
		if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
			const extracted = rawText.slice(firstBrace, lastBrace + 1);
			console.log(`\n--- CURRENT EXTRACTION (${extracted.length} chars) ---`);
			console.log(extracted.slice(0, 200));
			try {
				const parsed = JSON.parse(extracted);
				console.log("\n✅ PARSE OK:", JSON.stringify(parsed));
			} catch (e: any) {
				console.log(`\n❌ PARSE FAIL: ${e.message}`);
			}
		} else {
			console.log("\n⚠️ No braces found in response");
		}

		console.log(`\nUsage: input=${response.usage.input} output=${response.usage.output}`);
	} catch (err: any) {
		console.error(`❌ ERROR: ${err.message}`);
	}
}

async function main() {
	const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
	const QWEN_KEY = process.env.DASHSCOPE_API_KEY || process.env.ALIBABA_API_KEY;

	if (GEMINI_KEY) {
		await testModel(
			"gemini-2.5-flash",
			GEMINI_KEY,
			"https://generativelanguage.googleapis.com/v1beta/openai",
			"gemini",
		);
	} else {
		console.log("\n⚠️ No GEMINI_API_KEY — skipping Gemini test");
	}

	if (QWEN_KEY) {
		await testModel(
			"qwen-flash",
			QWEN_KEY,
			"https://dashscope.aliyuncs.com/compatible-mode/v1",
			"dashscope",
		);
	} else {
		console.log("\n⚠️ No DASHSCOPE_API_KEY — skipping Qwen test");
	}
}

main();
