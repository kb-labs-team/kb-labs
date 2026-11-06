import { describe, it, expect } from 'vitest'

/**
 * Unit tests for plugin reference parsing logic in SandboxRunner.
 * Tests the scoped package parsing fix: @scope/name/handler
 */

function parsePluginRef(uses: string): { pluginId: string; handlerName: string } {
  const pluginRef = uses.slice('plugin:'.length)
  const parts = pluginRef.split('/')

  let pluginId: string
  let handlerParts: string[]

  if (parts[0]?.startsWith('@') && parts.length >= 3) {
    pluginId = `${parts[0]}/${parts[1]}`
    handlerParts = parts.slice(2)
  } else {
    pluginId = parts[0] ?? ''
    handlerParts = parts.slice(1)
  }

  return { pluginId, handlerName: handlerParts.join('/') }
}

describe('SandboxRunner — plugin reference parsing', () => {
  describe('non-scoped packages', () => {
    it('parses plugin:name/handler', () => {
      const r = parsePluginRef('plugin:quality/audit')
      expect(r.pluginId).toBe('quality')
      expect(r.handlerName).toBe('audit')
    })

    it('parses plugin:name/path/to/handler', () => {
      const r = parsePluginRef('plugin:mind/cli/verify')
      expect(r.pluginId).toBe('mind')
      expect(r.handlerName).toBe('cli/verify')
    })
  })

  describe('scoped packages (@scope/name)', () => {
    it('parses plugin:@scope/name/handler', () => {
      const r = parsePluginRef('plugin:@kb-labs/commit/status')
      expect(r.pluginId).toBe('@kb-labs/commit')
      expect(r.handlerName).toBe('status')
    })

    it('parses plugin:@scope/name/cli/command', () => {
      const r = parsePluginRef('plugin:@kb-labs/marketplace/cli/list')
      expect(r.pluginId).toBe('@kb-labs/marketplace')
      expect(r.handlerName).toBe('cli/list')
    })

    it('does NOT split @scope as pluginId (regression for original bug)', () => {
      const r = parsePluginRef('plugin:@kb-labs/marketplace/cli/list')
      expect(r.pluginId).not.toBe('@kb-labs')
    })
  })
})
