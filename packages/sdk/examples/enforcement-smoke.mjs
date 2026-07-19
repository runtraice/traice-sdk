import { CloudAdapter, TraiceEnforcementError } from "../dist/index.js";

const { apiKey, endpoint, credentialSource } = await loadConnection();
const requestedModel = process.env.TRAICE_MODEL ?? "gpt-4o";
const feature = process.env.TRAICE_FEATURE ?? "enforcement-smoke";
const retryCount = nonNegativeInteger(process.env.TRAICE_RETRY_COUNT ?? "0", "TRAICE_RETRY_COUNT");
const failModel = process.env.TRAICE_FAIL_MODEL;
const providerCalls = [];

const cloud = new CloudAdapter({ apiKey, endpoint });
const request = {
  model: requestedModel,
  messages: [{ role: "user", content: "Reply with exactly: trAIce enforcement smoke test passed" }],
  temperature: 0,
  max_tokens: 20,
};

async function simulatedProvider(effectiveRequest) {
  providerCalls.push(effectiveRequest.model);
  if (effectiveRequest.model === failModel) throw new Error(`Simulated provider failure for ${effectiveRequest.model}`);
  return {
    object: "chat.completion",
    model: effectiveRequest.model,
    usage: { prompt_tokens: 12, completion_tokens: 8 },
    choices: [{ message: { role: "assistant", content: "trAIce enforcement smoke test passed" } }],
  };
}

async function realOpenAiProvider(effectiveRequest) {
  providerCalls.push(effectiveRequest.model);
  if (effectiveRequest.model === failModel) throw new Error(`Simulated provider failure for ${effectiveRequest.model}`);
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai.chat.completions.create(effectiveRequest);
}

async function main() {
  const enforcementReady = await cloud.warmEnforcement();
  if (!enforcementReady) throw new Error(`Could not load enforcement rules from ${endpoint}`);
  const provider = process.env.OPENAI_API_KEY ? realOpenAiProvider : simulatedProvider;
  console.log(
    JSON.stringify(
      {
        endpoint,
        credentialSource,
        enforcementReady,
        requestedModel,
        feature,
        retryCount,
        provider: process.env.OPENAI_API_KEY ? "openai" : "simulated",
      },
      null,
      2,
    ),
  );

  try {
    const response = await cloud.enforceRequest(request, provider, { feature, retryCount, provider: "openai" });
    await cloud.flush();
    console.log(
      JSON.stringify(
        {
          ok: true,
          requestedModel,
          providerCalls,
          responseModel: response.model ?? null,
          content: response.choices?.[0]?.message?.content ?? null,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await cloud.flush();
    if (error instanceof TraiceEnforcementError) {
      console.log(JSON.stringify({ ok: true, blocked: true, providerCalls, refusal: error.toJSON() }, null, 2));
      return;
    }
    throw error;
  }
}

async function loadConnection() {
  const explicitApiKey = process.env.TRAICE_API_KEY?.trim();
  if (explicitApiKey) {
    return {
      apiKey: explicitApiKey,
      endpoint: process.env.TRAICE_API_URL ?? "https://www.runtraice.com/api/v1/events",
      credentialSource: "TRAICE_API_KEY",
    };
  }

  try {
    const { loadCollectorConfig, readCollectorCredential } = await import("../../collector/dist/index.js");
    const config = loadCollectorConfig();
    const savedApiKey = await readCollectorCredential(config.credential);
    const serverUrl = config.serverUrl.replace(/\/$/, "");
    return {
      apiKey: savedApiKey,
      endpoint: process.env.TRAICE_API_URL ?? `${serverUrl}/api/v1/events`,
      credentialSource: "saved collector credential",
    };
  } catch (error) {
    throw new Error(
      `No saved collector credential was available. Set TRAICE_API_KEY or run the collector setup first. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
