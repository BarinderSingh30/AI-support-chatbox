import type { ChatProvider } from './provider.ts';

/** Defers construction so a missing API key does not stop the server booting. */
export function createLazyChatProvider(factory: () => ChatProvider): ChatProvider {
  let inner: ChatProvider | null = null;
  return {
    stream(request) {
      inner ??= factory();
      return inner.stream(request);
    },
  };
}
