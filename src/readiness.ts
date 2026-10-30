/** Wait for shared work without keeping a departed session alive. */
export function waitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    // Always attach handlers, even if already aborted: shared work may reject later.
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/** VCとTTSが両方準備できてから効果音を一度再生し、読み上げを解放する。 */
export async function announceReady(
  prerequisites: Promise<unknown>[],
  signal: AbortSignal,
  playSound: () => Promise<void>,
  soundError: (error: unknown) => void,
  startQueue: () => void,
): Promise<void> {
  await waitWithAbort(Promise.all(prerequisites), signal);
  signal.throwIfAborted();
  try {
    await playSound();
  } catch (error) {
    soundError(error);
  }
  signal.throwIfAborted();
  startQueue();
}
