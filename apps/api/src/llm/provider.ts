export interface ChatRequest {
  system: string;
  user: string;
  model: string;
  temperature?: number;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Streaming chat completion.
 *
 * Modelled as an async generator whose RETURN value carries token usage, so a
 * caller can stream text to the client and still record exact cost when the
 * stream ends. Keeping this an interface is what makes swapping Gemini for
 * Claude or GPT a one-file change.
 */
export interface ChatProvider {
  stream(request: ChatRequest): AsyncGenerator<string, ChatUsage, undefined>;
}
