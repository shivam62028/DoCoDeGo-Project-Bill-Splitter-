import { Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) => c.json({ status: 'ok' }))

// Creates a home. No validation beyond the name being a non-empty string,
// because the request shape is trivial and the database enforces NOT NULL.
app.post('/api/homes', async (c) => {
  // A body that is not valid JSON is treated as empty; the checks below turn it into a 400.
  const body: { name?: unknown } = await c.req.json<{ name?: unknown }>().catch(() => ({}))

  if (typeof body?.name !== 'string' || body.name.trim() === '') {
    return c.json({ error: 'name is required' }, 400)
  }

  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)').bind(id, body.name).run()

  return c.json({ id, name: body.name }, 201)
})

// Adds a member to a home. The FK constraint in the schema would also reject
// an unknown home, but we check first to return the spec's 404 with a clean message.
app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  const body: { name?: unknown } = await c.req.json<{ name?: unknown }>().catch(() => ({}))

  if (typeof body?.name !== 'string' || body.name.trim() === '') {
    return c.json({ error: 'name is required' }, 400)
  }

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'home not found' }, 404)
  }

  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO members (id, home_id, name) VALUES (?, ?, ?)')
    .bind(id, homeId, body.name)
    .run()

  return c.json({ id, homeId, name: body.name }, 201)
})

// Creates a bill and splits it evenly across the home's members.
// Extra cents (when totalCents does not divide evenly) go to earlier members.
app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const body: { title?: unknown; totalCents?: unknown } = await c.req
    .json<{ title?: unknown; totalCents?: unknown }>()
    .catch(() => ({}))

  if (typeof body?.title !== 'string' || body.title.trim() === '') {
    return c.json({ error: 'title is required' }, 400)
  }
  // Must be a real number (not a numeric string, not null) that is a positive integer.
  if (
    typeof body?.totalCents !== 'number' ||
    !Number.isInteger(body.totalCents) ||
    body.totalCents <= 0
  ) {
    return c.json({ error: 'totalCents must be a positive whole number' }, 422)
  }

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'home not found' }, 404)
  }

  // rowid preserves insertion order, which is the order members were added.
  const { results: members } = await c.env.DB.prepare(
    'SELECT id FROM members WHERE home_id = ? ORDER BY rowid',
  )
    .bind(homeId)
    .all()
  if (members.length === 0) {
    return c.json({ error: 'home has no members' }, 422)
  }

  // Split: everyone gets floor(total/n); the first (total % n) members get one extra cent.
  const totalCents = body.totalCents
  const base = Math.floor(totalCents / members.length)
  const remainder = totalCents % members.length

  const billId = crypto.randomUUID()
  const shares = members.map((member, index) => ({
    id: crypto.randomUUID(),
    memberId: member.id as string,
    amountCents: base + (index < remainder ? 1 : 0),
    paidAt: null,
  }))

  // batch() runs all statements in one transaction: the bill and its shares
  // are written together or not at all.
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)',
    ).bind(billId, homeId, body.title, totalCents),
    ...shares.map((share) =>
      c.env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
      ).bind(share.id, billId, share.memberId, share.amountCents),
    ),
  ])

  return c.json({ id: billId, homeId, title: body.title, totalCents, shares }, 201)
})

// Lists the bills of a home with their shares, newest last.
// Two plain queries joined in code: easier to read than one grouped SQL query.
app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'home not found' }, 404)
  }

  const { results: bills } = await c.env.DB.prepare(
    'SELECT id, home_id AS homeId, title, total_cents AS totalCents FROM bills WHERE home_id = ? ORDER BY rowid',
  )
    .bind(homeId)
    .all()
  const { results: shares } = await c.env.DB.prepare(
    `SELECT s.id, s.bill_id AS billId, s.member_id AS memberId, s.amount_cents AS amountCents, s.paid_at AS paidAt
     FROM shares s JOIN bills b ON b.id = s.bill_id
     WHERE b.home_id = ?
     ORDER BY s.rowid`,
  )
    .bind(homeId)
    .all()

  return c.json({
    bills: bills.map((bill) => ({
      ...bill,
      shares: shares.filter((share) => share.billId === bill.id),
    })),
  })
})

// Pays one share. The Idempotency-Key makes retries safe:
// - same key on the same share  -> 200 with the original result (no double pay)
// - different key on a paid share -> 409
app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const key = c.req.header('Idempotency-Key')

  if (!key) {
    return c.json({ error: 'Idempotency-Key header is required' }, 400)
  }

  const share = await c.env.DB.prepare(
    'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ? AND bill_id = ?',
  )
    .bind(shareId, billId)
    .first<{
      id: string
      member_id: string
      amount_cents: number
      paid_at: string | null
      idempotency_key: string | null
    }>()
  if (!share) {
    return c.json({ error: 'bill or share not found' }, 404)
  }

  if (share.paid_at) {
    if (share.idempotency_key === key) {
      return c.json(
        {
          id: share.id,
          memberId: share.member_id,
          amountCents: share.amount_cents,
          paidAt: share.paid_at,
        },
        200,
      )
    }
    return c.json({ error: 'share already paid' }, 409)
  }

  const paidAt = new Date().toISOString()
  // Conditional update ("compare and set"): only flips the row if it is still
  // unpaid. D1 serializes writes, so of two concurrent payments only one
  // UPDATE actually changes a row; the loser re-reads and answers below.
  const result = await c.env.DB.prepare(
    'UPDATE shares SET paid_at = ?, idempotency_key = ? WHERE id = ? AND paid_at IS NULL',
  )
    .bind(paidAt, key, shareId)
    .run()

  if (result.meta.changes === 0) {
    // Lost the race: someone paid this share between our SELECT and UPDATE.
    const winner = await c.env.DB.prepare(
      'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ?',
    )
      .bind(shareId)
      .first<{
        id: string
        member_id: string
        amount_cents: number
        paid_at: string
        idempotency_key: string | null
      }>()
    if (winner && winner.idempotency_key === key) {
      // Same key raced itself: still an idempotent replay of the same payment.
      return c.json(
        {
          id: winner.id,
          memberId: winner.member_id,
          amountCents: winner.amount_cents,
          paidAt: winner.paid_at,
        },
        200,
      )
    }
    return c.json({ error: 'share already paid' }, 409)
  }

  return c.json(
    { id: shareId, memberId: share.member_id, amountCents: share.amount_cents, paidAt },
    200,
  )
})

// Lists what each member still owes: the sum of their unpaid shares across all
// bills of the home, in the order members were added.
app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')

  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) {
    return c.json({ error: 'home not found' }, 404)
  }

  const { results } = await c.env.DB.prepare(
    `SELECT m.id AS memberId, m.name AS name,
            COALESCE(SUM(CASE WHEN s.paid_at IS NULL THEN s.amount_cents ELSE 0 END), 0) AS outstandingCents
     FROM members m
     LEFT JOIN shares s ON s.member_id = m.id
     WHERE m.home_id = ?
     GROUP BY m.id, m.name
     ORDER BY m.rowid`,
  )
    .bind(homeId)
    .all()

  return c.json({ balances: results }, 200)
})

export default app
