/** VCとTTSが両方準備できてから効果音を一度再生し、読み上げを解放する。 */
export async function announceReady(
  prerequisites: Promise<unknown>[],
  signal: AbortSignal,
  playSound: () => Promise<void>,
  soundError: (error: unknown) => void,
  startQueue: () => void,
): Promise<void> {
  await Promise.all(prerequisites);
  signal.throwIfAborted();
  try {
    await playSound();
  } catch (error) {
    soundError(error);
  }
  signal.throwIfAborted();
  startQueue();
}
