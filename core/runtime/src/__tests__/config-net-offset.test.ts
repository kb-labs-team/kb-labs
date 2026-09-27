import { describe, expect, it } from 'vitest'

import { applyLocalNetworkOffset } from '../config-net-offset.js'

describe('applyLocalNetworkOffset', () => {
  it('shifts loopback infrastructure URLs but not remote URLs or service transport routes', () => {
    const result = applyLocalNetworkOffset({
      adapterOptions: {
        cache: { url: 'redis://localhost:6379' },
        vectorStore: { url: 'http://127.0.0.1:6333' },
        remote: { url: 'redis://redis.internal:6379' },
        serviceTransport: {
          services: { workflow: { url: 'http://localhost:7778' } },
        },
      },
    }, { KB_NET_OFFSET: '1000' })

    expect(result).toEqual({
      adapterOptions: {
        cache: { url: 'redis://localhost:7379' },
        vectorStore: { url: 'http://127.0.0.1:7333' },
        remote: { url: 'redis://redis.internal:6379' },
        serviceTransport: {
          services: { workflow: { url: 'http://localhost:7778' } },
        },
      },
    })
  })

  it('is a no-op without a network offset', () => {
    const config = { adapterOptions: { cache: { url: 'redis://localhost:6379' } } }
    expect(applyLocalNetworkOffset(config, {})).toBe(config)
  })

  it('leaves explicitly exempt host-service URLs on their configured ports', () => {
    const result = applyLocalNetworkOffset({
      networkOffsetExemptions: ['adapterOptions.llm'],
      adapterOptions: {
        llm: { baseURL: 'http://localhost:8317' },
        cache: { url: 'redis://localhost:6379' },
      },
    }, { KB_NET_OFFSET: '400' })

    expect(result).toEqual({
      adapterOptions: {
        llm: { baseURL: 'http://localhost:8317' },
        cache: { url: 'redis://localhost:6779' },
      },
    })
  })
})
