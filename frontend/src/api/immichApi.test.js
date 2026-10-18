import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchImmichAsset, listImmichAssets } from './immichApi.js'

afterEach(() => vi.unstubAllGlobals())
describe('Recherche et aperçus Immich', () => {
  it('encode le contexte et conserve le visage, la page et l’annulation', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"assets":[],"hasNextPage":false}'))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    await listImmichAssets('arbre/1', 'token', 3, 'IMAGE', { query: ' été & mer ', personId: 'face-1', signal: controller.signal })
    const [url, options] = fetch.mock.calls[0]
    const parsed = new URL(url, 'http://localhost')
    expect(parsed.pathname).toContain('arbre%2F1')
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ page: '3', type: 'IMAGE', q: 'été & mer', personId: 'face-1' })
    expect(options.signal).toBe(controller.signal)
    expect(options.headers.Authorization).toBe('Bearer token')
  })
  it('ouvre un aperçu sans télécharger l’original', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('image', { headers: { 'content-type': 'image/jpeg' } }))
    vi.stubGlobal('fetch', fetch)
    const blob = await fetchImmichAsset('tree', 'photo', 'token', 'preview')
    expect(fetch.mock.calls[0][0]).toMatch(/\/assets\/photo\/preview$/)
    expect(blob.type).toBe('image/jpeg')
  })
})
