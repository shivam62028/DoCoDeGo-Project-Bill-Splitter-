import { describe, expect, it } from 'vitest'
import { call, type Member } from './helpers'

describe('homes and members', () => {
  it('creates a home', async () => {
    const created = await call<{ id: string; name: string }>('POST', '/api/homes', {
      body: { name: 'Flat 4B' },
    })

    expect(created.status).toBe(201)
    expect(created.body.name).toBe('Flat 4B')
    expect(created.body.id).toEqual(expect.any(String))
  })

  it('adds a member to a home', async () => {
    const home = await call<{ id: string }>('POST', '/api/homes', { body: { name: 'Flat 4B' } })
    const member = await call<Member>('POST', `/api/homes/${home.body.id}/members`, {
      body: { name: 'Asha' },
    })

    expect(member.status).toBe(201)
    expect(member.body).toMatchObject({ homeId: home.body.id, name: 'Asha' })
  })

  it('returns 404 when the home does not exist', async () => {
    const member = await call('POST', '/api/homes/does-not-exist/members', {
      body: { name: 'Asha' },
    })

    expect(member.status).toBe(404)
  })
})
