// One structured line per event, for Workers Logs (D-17). Workers Logs stamps the time.
// Never pass a secret, a token, or the x-satchel-key header value in `fields`.
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ...fields, event }));
}
