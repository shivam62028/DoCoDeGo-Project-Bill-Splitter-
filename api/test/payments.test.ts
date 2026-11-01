import { describe, expect, it } from 'vitest'
import { type Balance, call, createBill, createHome, type Share } from './helpers'

async function setup() {
  const { homeId, members } = await createHome(['Asha', 'Ben'])
  const bill = await createBill(homeId, 1000)
  const firstShare = bill.body.shares[0]
  if (!firstShare) throw new Error('bill has no shares')
  return { homeId, members, billId: bill.body.id, firstShare }
}

function pay(billId: string, shareId: string, key?: string) {
  return call<Share>('POST', `/api/bills/${billId}/shares/${shareId}/pay`, {
    headers: key ? { 'Idempotency-Key': key } : {},
  })
}

function balances(homeId: string) {
  return call<{ balances: Balance[] }>('GET', `/api/homes/${homeId}/balances`)
}

describe('pay a share', () => {
  it('marks the share as paid', async () => {
    const { billId, firstShare } = await setup()

    const paid = await pay(billId, firstShare.id, crypto.randomUUID())

    expect(paid.status).toBe(200)
    expect(paid.body.id).toBe(firstShare.id)
    expect(paid.body.paidAt).toEqual(expect.any(String))
  })

  it('rejects a request with no Idempotency-Key header', async () => {
    const { billId, firstShare } = await setup()

    const paid = await pay(billId, firstShare.id)

    expect(paid.status).toBe(400)
  })

  it('returns the same answer when the same key is sent twice, and pays once', async () => {
    const { homeId, billId, firstShare } = await setup()
    const key = crypto.randomUUID()

    const first = await pay(billId, firstShare.id, key)
    const second = await pay(billId, firstShare.id, key)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body.paidAt).toBe(first.body.paidAt)
    const outstanding = await balances(homeId)
    expect(outstanding.body.balances.map((balance) => balance.outstandingCents)).toEqual([0, 500])
  })

  it('rejects a second payment of an already paid share with a different key', async () => {
    const { billId, firstShare } = await setup()
    await pay(billId, firstShare.id, crypto.randomUUID())

    const again = await pay(billId, firstShare.id, crypto.randomUUID())

    expect(again.status).toBe(409)
  })

  it('returns 404 when the share does not exist', async () => {
    const { billId } = await setup()

    const paid = await pay(billId, 'does-not-exist', crypto.randomUUID())

    expect(paid.status).toBe(404)
  })

  it('returns 404 when the bill does not exist', async () => {
    const { firstShare } = await setup()

    const paid = await pay('does-not-exist', firstShare.id, crypto.randomUUID())

    expect(paid.status).toBe(404)
  })
})

describe('balances', () => {
  it('lists what each member still owes, in the order members were added', async () => {
    const { homeId, members } = await setup()

    const outstanding = await balances(homeId)

    expect(outstanding.status).toBe(200)
    expect(outstanding.body.balances).toEqual([
      { memberId: members[0]?.id, name: 'Asha', outstandingCents: 500 },
      { memberId: members[1]?.id, name: 'Ben', outstandingCents: 500 },
    ])
  })

  it('adds up the unpaid shares of several bills', async () => {
    const { homeId, billId, firstShare } = await setup()
    await createBill(homeId, 300)
    await pay(billId, firstShare.id, crypto.randomUUID())

    const outstanding = await balances(homeId)

    expect(outstanding.body.balances.map((balance) => balance.outstandingCents)).toEqual([150, 650])
  })

  it('returns 404 when the home does not exist', async () => {
    const outstanding = await balances('does-not-exist')

    expect(outstanding.status).toBe(404)
  })
})
