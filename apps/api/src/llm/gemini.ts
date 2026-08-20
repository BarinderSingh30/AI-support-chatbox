import { GoogleGenAI } from '@google/genai';
import { env } from '../env.ts';
import type { ChatProvider, ChatRequest, ChatUsage } from './provider.ts';

export function createGeminiChatProvider(apiKey = env.GEMINI_API_KEY): ChatProvider {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const ai = new GoogleGenAI({ apiKey });

  return {
    async *stream(request: ChatRequest): AsyncGenerator<string, ChatUsage, undefined> {
      const response = await ai.models.generateContentStream({
        model: request.model,
        contents: [{ role: 'user', parts: [{ text: request.user }] }],
        config: {
          systemInstruction: request.system,
          // Low but not zero: grounded extraction wants determinism, and
          // temperature is one of the cheapest hallucination controls there is.
          temperature: request.temperature ?? 0.1,
        },
      });

      let usage: ChatUsage = { inputTokens: 0, outputTokens: 0 };
      for await (const part of response) {
        const text = part.text;
        if (text) yield text;
        if (part.usageMetadata) {
          usage = {
            inputTokens: part.usageMetadata.promptTokenCount ?? 0,
            outputTokens: part.usageMetadata.candidatesTokenCount ?? 0,
          };
        }
      }
      return usage;
    },
  };
}
