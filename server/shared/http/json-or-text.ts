export async function jsonOrTextResult(
  response: Response,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}
