export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), event, ...fields }),
  );
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
