/**
 * Deterministic short-circuit for conversational filler — greetings,
 * thanks, acknowledgments, farewells — so they skip the document relevance
 * gate entirely instead of getting told "I couldn't find that in the
 * documentation," which is true but unhelpful for a message that was never
 * a question in the first place. No embedding call, no LLM call: same
 * cost-avoidance principle as the relevance gate itself.
 */
const REPLIES = {
  greeting: 'Hi there! What can I help you with?',
  thanks: "You're welcome! Let me know if you have any other questions.",
  acknowledgment: "Got it — let me know if there's anything else I can help with.",
  farewell: 'Goodbye! Feel free to come back if you have more questions.',
} as const;

const PHRASES: Record<keyof typeof REPLIES, string[]> = {
  greeting: ['hi', 'hello', 'hey', 'hiya', 'yo', 'good morning', 'good afternoon', 'good evening'],
  thanks: ['thanks', 'thank you', 'thx', 'ty', 'cheers', 'appreciate it'],
  acknowledgment: [
    'ok', 'okay', 'k', 'kk', 'got it', 'gotcha', 'cool', 'great', 'nice',
    'alright', 'sounds good', 'perfect', 'awesome', 'noted',
  ],
  farewell: ['bye', 'goodbye', 'see ya', 'see you', 'later', 'cya', 'take care'],
};

const LOOKUP = new Map<string, string>(
  Object.entries(PHRASES).flatMap(([category, phrases]) =>
    phrases.map((phrase) => [phrase, REPLIES[category as keyof typeof REPLIES]] as const),
  ),
);

/**
 * Matches only when the ENTIRE message (after trimming punctuation) is one of
 * the known phrases — "thanks for nothing, this is useless" must still reach
 * the relevance gate, not get treated as gratitude.
 */
export function matchConversational(text: string): string | null {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/, '');
  return LOOKUP.get(normalized) ?? null;
}
