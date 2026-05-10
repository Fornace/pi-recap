import { generateUserRecap, generateAgentRecap } from "./subagent/recap.js";
import { deriveGoalInitial } from "./subagent/goal.js";

const mockRegistry = {
  getAvailable: () => [
    { id: "gemini-1.5-flash", cost: { input: 0.05, output: 0.1 } },
    { id: "gemini-1.5-pro", cost: { input: 2.0, output: 4.0 } }
  ],
  getApiKeyAndHeaders: async (_model: { id: string; cost: { input: number; output: number } }) => {
    return { ok: true, apiKey: "fake-key", headers: {} };
  }
};

const messages = [
  { role: "user", content: "we need to build a simple server", timestamp: Date.now() },
  { role: "assistant", content: "I will use express.js for this.", timestamp: Date.now() },
];

async function run() {
  console.log("Testing generateUserRecap...");
  const u = await generateUserRecap("we need to build a simple server", mockRegistry as any);
  console.log("User recap:", u);

  console.log("Testing generateAgentRecap...");
  const a = await generateAgentRecap(messages as any, mockRegistry as any);
  console.log("Agent recap:", a);

  console.log("Testing deriveGoalInitial...");
  const g = await deriveGoalInitial(messages as any, mockRegistry as any);
  console.log("Goal:", g);
}

run().catch(console.error);
