import { createFileRoute } from '@tanstack/react-router'
import { type FormEvent, useEffect, useState } from 'react'
import { api, type Balance, type Bill, formatCents } from '../api'

export const Route = createFileRoute('/')({
  component: Page,
})

// The current home is kept in localStorage so a refresh keeps you in the same home.
const HOME_STORAGE_KEY = 'bill-splitter.home'
type StoredHome = { id: string; name: string }

function loadStoredHome(): StoredHome | null {
  try {
    const raw = localStorage.getItem(HOME_STORAGE_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && 'id' in parsed && 'name' in parsed) {
      const { id, name } = parsed as Record<string, unknown>
      if (typeof id === 'string' && typeof name === 'string') return { id, name }
    }
    return null
  } catch {
    return null
  }
}

type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T }

// Fetches one API path and tracks loading / error / ready for the UI.
// Refetches when `path` changes or `reload()` is called after an action.
function useApiData<T>(path: string) {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' })
  const [tick, setTick] = useState(0)

  // `tick` is never read inside the effect on purpose: changing it is what
  // triggers the refetch, so it must stay in the dependency list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is a refetch trigger
  useEffect(() => {
    let active = true // guards against setting state after unmount/race
    api<T>(path)
      .then((data) => {
        if (active) setState({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Something went wrong',
          })
        }
      })
    return () => {
      active = false
    }
  }, [path, tick])

  return { state, reload: () => setTick((value) => value + 1) }
}

function Page() {
  const [home, setHome] = useState<StoredHome | null>(loadStoredHome)

  if (home === null) {
    return (
      <main style={styles.page}>
        <CreateHome onCreated={setHome} />
      </main>
    )
  }
  return (
    <main style={styles.page}>
      <Dashboard home={home} onLeave={() => setHome(null)} />
    </main>
  )
}

function CreateHome({ onCreated }: { onCreated: (home: StoredHome) => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const home = await api<StoredHome>('/api/homes', { method: 'POST', body: { name } })
      localStorage.setItem(HOME_STORAGE_KEY, JSON.stringify(home))
      onCreated(home)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the home')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={styles.card}>
      <h1 style={styles.title}>Bill Splitter</h1>
      <p style={styles.muted}>Create a shared home to get started.</p>
      <form onSubmit={submit} style={styles.formRow}>
        <input
          style={styles.input}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Home name, e.g. Flat 4B"
          disabled={busy}
        />
        <button type="submit" style={styles.button} disabled={busy || name.trim() === ''}>
          {busy ? 'Creating…' : 'Create home'}
        </button>
      </form>
      {error !== null && <p style={styles.errorText}>{error}</p>}
    </section>
  )
}

function Dashboard({ home, onLeave }: { home: StoredHome; onLeave: () => void }) {
  const balances = useApiData<{ balances: Balance[] }>(`/api/homes/${home.id}/balances`)
  const bills = useApiData<{ bills: Bill[] }>(`/api/homes/${home.id}/bills`)
  const [payingShareId, setPayingShareId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // memberId -> name, used to label shares in the bills list.
  const memberNames = new Map<string, string>()
  if (balances.state.status === 'ready') {
    for (const balance of balances.state.data.balances) {
      memberNames.set(balance.memberId, balance.name)
    }
  }

  async function pay(billId: string, shareId: string) {
    setPayingShareId(shareId)
    setActionError(null)
    try {
      // A fresh key per attempt: if the response is lost and the user retries,
      // the server answers 409 "already paid" instead of charging twice.
      await api(`/api/bills/${billId}/shares/${shareId}/pay`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      })
      bills.reload()
      balances.reload()
    } catch (err) {
      // No optimistic update happened, so the share stays unpaid on screen.
      setActionError(err instanceof Error ? err.message : 'Payment failed')
    } finally {
      setPayingShareId(null)
    }
  }

  function addMember() {
    balances.reload()
  }
  function addBill() {
    bills.reload()
    balances.reload()
  }

  return (
    <>
      <header style={styles.header}>
        <h1 style={styles.title}>{home.name}</h1>
        <button type="button" style={styles.ghostButton} onClick={onLeave}>
          Use a different home
        </button>
      </header>

      {actionError !== null && (
        <p style={styles.errorBanner} role="alert">
          {actionError}
        </p>
      )}

      <section style={styles.card}>
        <h2 style={styles.sectionTitle}>Balances</h2>
        {balances.state.status === 'loading' && <p style={styles.muted}>Loading balances…</p>}
        {balances.state.status === 'error' && (
          <ErrorBox message={balances.state.message} onRetry={balances.reload} />
        )}
        {balances.state.status === 'ready' && balances.state.data.balances.length === 0 && (
          <p style={styles.muted}>No members yet. Add the first one below.</p>
        )}
        {balances.state.status === 'ready' && balances.state.data.balances.length > 0 && (
          <ul style={styles.list}>
            {balances.state.data.balances.map((balance) => (
              <li key={balance.memberId} style={styles.listRow}>
                <span>{balance.name}</span>
                <span style={styles.money}>{formatCents(balance.outstandingCents)}</span>
              </li>
            ))}
          </ul>
        )}
        <AddMemberForm homeId={home.id} onAdded={addMember} />
      </section>

      <section style={styles.card}>
        <h2 style={styles.sectionTitle}>Bills</h2>
        {bills.state.status === 'loading' && <p style={styles.muted}>Loading bills…</p>}
        {bills.state.status === 'error' && (
          <ErrorBox message={bills.state.message} onRetry={bills.reload} />
        )}
        {bills.state.status === 'ready' && bills.state.data.bills.length === 0 && (
          <p style={styles.muted}>No bills yet. Add the first one below.</p>
        )}
        {bills.state.status === 'ready' &&
          bills.state.data.bills.map((bill) => (
            <div key={bill.id} style={styles.billBox}>
              <div style={styles.billHead}>
                <strong>{bill.title}</strong>
                <span style={styles.money}>{formatCents(bill.totalCents)}</span>
              </div>
              <ul style={styles.list}>
                {bill.shares.map((share) => {
                  const paying = payingShareId === share.id
                  return (
                    <li key={share.id} style={styles.listRow}>
                      <span>{memberNames.get(share.memberId) ?? 'Member'}</span>
                      <span style={styles.shareRight}>
                        <span style={styles.money}>{formatCents(share.amountCents)}</span>
                        {share.paidAt !== null ? (
                          <span style={styles.paidBadge}>Paid</span>
                        ) : (
                          <button
                            type="button"
                            style={styles.button}
                            disabled={payingShareId !== null}
                            onClick={() => pay(bill.id, share.id)}
                          >
                            {paying ? 'Paying…' : 'Pay'}
                          </button>
                        )}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        <CreateBillForm homeId={home.id} onCreated={addBill} />
      </section>
    </>
  )
}

function AddMemberForm({ homeId, onAdded }: { homeId: string; onAdded: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api(`/api/homes/${homeId}/members`, { method: 'POST', body: { name } })
      setName('')
      onAdded()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the member')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} style={styles.formColumn}>
      <div style={styles.formRow}>
        <input
          style={styles.input}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="New member name"
          disabled={busy}
        />
        <button type="submit" style={styles.button} disabled={busy || name.trim() === ''}>
          {busy ? 'Adding…' : 'Add member'}
        </button>
      </div>
      {error !== null && <p style={styles.errorText}>{error}</p>}
    </form>
  )
}

function CreateBillForm({ homeId, onCreated }: { homeId: string; onCreated: () => void }) {
  const [title, setTitle] = useState('')
  const [cents, setCents] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const totalCents = Number(cents)
    // Same rule as the API, checked early for a friendlier message.
    if (!Number.isInteger(totalCents) || totalCents <= 0) {
      setError('Enter a positive whole number of cents, e.g. 2500 for $25.00')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api(`/api/homes/${homeId}/bills`, {
        method: 'POST',
        body: { title, totalCents },
      })
      setTitle('')
      setCents('')
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the bill')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} style={styles.formColumn}>
      <div style={styles.formRow}>
        <input
          style={styles.input}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Bill title, e.g. Electricity"
          disabled={busy}
        />
        <input
          style={styles.input}
          value={cents}
          onChange={(event) => setCents(event.target.value)}
          placeholder="Total in cents, e.g. 2500"
          inputMode="numeric"
          disabled={busy}
        />
        <button type="submit" style={styles.button} disabled={busy || title.trim() === ''}>
          {busy ? 'Adding…' : 'Add bill'}
        </button>
      </div>
      {error !== null && <p style={styles.errorText}>{error}</p>}
    </form>
  )
}

function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div>
      <p style={styles.errorText} role="alert">
        {message}
      </p>
      <button type="button" style={styles.ghostButton} onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

const styles = {
  page: {
    maxWidth: 720,
    margin: '0 auto',
    padding: 24,
    fontFamily: 'system-ui, sans-serif',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  } as const,
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } as const,
  title: { margin: 0, fontSize: 24 } as const,
  sectionTitle: { margin: '0 0 8px', fontSize: 18 } as const,
  card: {
    background: '#fff',
    border: '1px solid #e4e6eb',
    borderRadius: 10,
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  } as const,
  billBox: { borderTop: '1px solid #eef0f3', paddingTop: 12 } as const,
  billHead: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 } as const,
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  } as const,
  listRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  } as const,
  shareRight: { display: 'flex', alignItems: 'center', gap: 8 } as const,
  money: { fontVariantNumeric: 'tabular-nums' } as const,
  paidBadge: {
    background: '#e7f6ec',
    color: '#177245',
    borderRadius: 999,
    padding: '2px 10px',
    fontSize: 12,
  } as const,
  formRow: { display: 'flex', gap: 8, flexWrap: 'wrap' as const } as const,
  formColumn: { display: 'flex', flexDirection: 'column', gap: 6 } as const,
  input: {
    flex: 1,
    minWidth: 160,
    padding: '8px 10px',
    border: '1px solid #d0d4dc',
    borderRadius: 8,
    fontSize: 14,
  } as const,
  button: {
    padding: '8px 14px',
    borderRadius: 8,
    border: '1px solid #2563eb',
    background: '#2563eb',
    color: '#fff',
    fontSize: 14,
    cursor: 'pointer',
  } as const,
  ghostButton: {
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid #d0d4dc',
    background: '#fff',
    color: '#333',
    fontSize: 13,
    cursor: 'pointer',
  } as const,
  muted: { color: '#6b7280', margin: 0 } as const,
  errorText: { color: '#b42318', margin: 0 } as const,
  errorBanner: {
    background: '#fdecea',
    color: '#b42318',
    border: '1px solid #f5c6c0',
    borderRadius: 8,
    padding: '10px 12px',
    margin: 0,
  } as const,
}
