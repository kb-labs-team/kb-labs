#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SUPPORTED_SCHEMAS = new Set(['kb.service/1', 'kb.adapter/1', 'kb.plugin/3'])

export async function emitManifestJson({ manifestModule, outputPath }) {
  if (!manifestModule || !outputPath) {
    throw new TypeError('manifestModule and outputPath are required')
  }
  const moduleUrl = pathToFileURL(resolve(manifestModule)).href
  const imported = await import(moduleUrl)
  const manifest = imported.manifest
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError(`manifest module ${manifestModule} must export an object named manifest`)
  }
  if (!SUPPORTED_SCHEMAS.has(manifest.schema)) {
    throw new TypeError(`manifest module ${manifestModule} must declare schema kb.service/1, kb.adapter/1, or kb.plugin/3`)
  }
  const output = resolve(outputPath)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`)
  if (manifest.schema === 'kb.adapter/1') {
    const requirements = []
    for (const [key, option] of Object.entries(manifest.configSchema ?? {})) {
      if (!option.doctor) continue
      if (!option.required || !option.secret || !option.env || !Array.isArray(option.doctor)) {
        throw new TypeError(`adapter manifest ${manifest.id} option ${key} doctor metadata must be a list for a required secret with an environment source`)
      }
      for (const doctor of option.doctor) {
        if (typeof doctor.slot !== 'string' || !Object.hasOwn(manifest.defaultFor ?? {}, doctor.slot)) {
          throw new TypeError(`adapter manifest ${manifest.id} option ${key} doctor metadata must name a declared default slot`)
        }
        const slot = doctor.slot
        const pointer = value => value.replaceAll('~', '~0').replaceAll('/', '~1')
        requirements.push({
          id: doctor.id,
          path: `/platform/adapterOptions/${pointer(slot)}/${pointer(key)}`,
          required: option.required,
          ...(doctor.optional !== undefined ? { optional: doctor.optional } : {}),
          ...(doctor.severity ? { severity: doctor.severity } : {}),
          secret: option.secret,
          env: option.env,
          services: doctor.services,
          ...(doctor.action ? { action: doctor.action } : {}),
          hint: doctor.hint,
        })
      }
    }
    writeFileSync(join(dirname(output), 'kb-create.requirements.json'), `${JSON.stringify({
      schema: 'kb.create.requirements/v1',
      requirements,
    }, null, 2)}\n`)
  }
  return manifest
}

async function main(args) {
  const moduleIndex = args.indexOf('--module')
  const outputIndex = args.indexOf('--output')
  if (moduleIndex < 0 || outputIndex < 0 || !args[moduleIndex + 1] || !args[outputIndex + 1]) {
    throw new TypeError('usage: emit-manifest-json.mjs --module <manifest-module> --output <manifest.json>')
  }
  await emitManifestJson({ manifestModule: args[moduleIndex + 1], outputPath: args[outputIndex + 1] })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`[kb-devkit] ${error.message}\n`)
    process.exitCode = 1
  })
}
