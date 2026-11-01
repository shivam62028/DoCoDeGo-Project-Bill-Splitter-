// Types mirroring the API responses.
export type Share = { id: string; memberId: string; amountCents: number; paidAt: string | null }
export type Bill = {
  id: string
  homeId: string
  title: string
  totalCents: number
  shares: Share[]
}
export type Balance = { memberId: string; name: string; outstandingCents: number }

// Error type for every failure the page should show a message for
// (server error responses, timeouts, network failures).
export class ApiError extends Error {}

type RequestOptions = {
  method?: 'GET' | 'POST'
  body?: unknown
  headers?: Record<string, string>
  timeoutMs?: number
}

// One fetch wrapper used by the whole page:
// - parses the JSON body and turns { error } responses into ApiError,
// - aborts requests that take longer than timeoutMs (default 10s).
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {}, timeoutMs = 10_000 } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const data: unknown = await response.json().catch(() => null)

    if (!response.ok) {
      const message =
        data !== null && typeof data === 'object' && 'error' in data
          ? String((data as { error: unknown }).error)
          : `Request failed with status ${response.status}`
      throw new ApiError(message)
    }
    return data as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('The API took too long to answer. Please try again.')
    }
    throw new ApiError('Could not reach the API. Is the server running?')
  } finally {
    clearTimeout(timer)
  }
}

// Display-only formatting. All money math happens on integer cents in the API;
// this is the only place a float appears, and only to render text.
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}
