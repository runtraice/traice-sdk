/**
 * The text of a request reduced to what trAIce can replay: a system prompt,
 * the user and assistant turns, and the sampling parameters that change an
 * answer. Sent only when the cloud adapter captures content and the
 * workspace has opted in to sampling.
 */
export interface CapturedRequest {
  system?: string;
  messages: CapturedRequestMessage[];
  params?: CapturedRequestParams;
}

export interface CapturedRequestMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CapturedRequestParams {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
}

/** trAIce rejects larger requests, so the SDK does not send them. */
export const CAPTURED_REQUEST_LIMITS = {
  maxMessages: 200,
  maxSerializedBytes: 128 * 1024,
} as const;

type UnknownRecord = Record<string, unknown>;

/**
 * Reduce an OpenAI Chat Completions, Anthropic Messages, or Amazon Bedrock
 * Converse request (or an already captured request) to a `CapturedRequest`.
 *
 * Returns `undefined` when the request carries something a text replay
 * cannot reproduce faithfully: tool calls or results, images, documents,
 * other non-text parts, a system message after the conversation starts, or
 * more than the size limits. Prompt-cache markers are ignored.
 */
export function captureRequest(input: unknown): CapturedRequest | undefined {
  if (!isRecord(input) || !Array.isArray(input.messages)) return undefined;

  const systemParts: string[] = [];
  const topLevelSystem = textOf(input.system);
  if (topLevelSystem === null) return undefined;
  if (topLevelSystem) systemParts.push(topLevelSystem);

  const messages: CapturedRequestMessage[] = [];
  for (const raw of input.messages) {
    if (!isRecord(raw)) return undefined;
    const role = raw.role;
    if (role === "system" || role === "developer") {
      // OpenAI puts instructions in leading messages; a later one has no place in the captured shape.
      if (messages.length > 0) return undefined;
      const text = textOf(raw.content);
      if (text === null) return undefined;
      if (text) systemParts.push(text);
      continue;
    }
    if (role !== "user" && role !== "assistant") return undefined;
    if (raw.tool_calls !== undefined || raw.function_call !== undefined) return undefined;
    const content = textOf(raw.content);
    if (!content) return undefined;
    messages.push({ role, content });
  }
  if (messages.length === 0 || messages.length > CAPTURED_REQUEST_LIMITS.maxMessages) return undefined;

  const captured: CapturedRequest = { messages };
  if (systemParts.length > 0) captured.system = systemParts.join("\n\n");
  const params = paramsOf(input);
  if (params) captured.params = params;

  if (utf8Length(JSON.stringify(captured)) > CAPTURED_REQUEST_LIMITS.maxSerializedBytes) return undefined;
  return captured;
}

/**
 * The plain text of a message's content: a string, or an array of text
 * blocks in OpenAI, Anthropic, or Converse form. `""` when there is no text,
 * `null` when a block is anything other than text or a cache marker.
 */
function textOf(content: unknown): string | null {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      texts.push(block);
      continue;
    }
    if (!isRecord(block)) return null;
    if (isCacheMarker(block)) continue;
    const type = block.type;
    if (type !== undefined && type !== "text" && type !== "input_text" && type !== "output_text") return null;
    if (typeof block.text !== "string") return null;
    if (type === undefined && Object.keys(block).some((key) => key !== "text")) return null;
    texts.push(block.text);
  }
  return texts.join("\n");
}

/** A Converse `cachePoint` block marks a cache boundary and carries no content. */
function isCacheMarker(block: UnknownRecord): boolean {
  return Object.keys(block).length === 1 && isRecord(block.cachePoint);
}

function paramsOf(input: UnknownRecord): CapturedRequestParams | undefined {
  const sources = [input, input.inferenceConfig, input.params].filter(isRecord);
  const pick = (...keys: string[]): number | undefined => {
    for (const source of sources) {
      for (const key of keys) {
        const value = source[key];
        if (typeof value === "number" && Number.isFinite(value)) return value;
      }
    }
    return undefined;
  };
  const params: CapturedRequestParams = {};
  const temperature = pick("temperature");
  const topP = pick("top_p", "topP");
  const maxOutputTokens = pick("maxOutputTokens", "max_completion_tokens", "max_tokens", "maxTokens");
  if (temperature !== undefined) params.temperature = temperature;
  if (topP !== undefined) params.topP = topP;
  if (maxOutputTokens !== undefined && maxOutputTokens > 0) params.maxOutputTokens = Math.floor(maxOutputTokens);
  return Object.keys(params).length > 0 ? params : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}
