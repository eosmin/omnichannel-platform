import { Injectable } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PinoLogger } from 'nestjs-pino'

import { localCarrierPlugin } from '@platform/carriers/local'
import { CarrierId } from '@platform/core/domain'
import type {
  CarrierConnectInput,
  CarrierContext,
  CarrierPlugin,
  LabelInput
} from '@platform/plugins/sdk'

import { CarrierRegistry } from './carrier-registry'
import type { CarrierPluginSource } from './official-plugins'
import { PluginsModule } from './plugins.module'

// The registry of the channels asks the environment for the public address of the api; a unit spec has no database to parse
jest.mock('@platform/core/config/env', () => ({
  envSource: (): Record<string, string> => ({ NODE_ENV: 'test' })
}))

describe('PluginsModule carriers', () => {
  const compile = (carriers: readonly CarrierPluginSource[]) =>
    Test.createTestingModule({ imports: [PluginsModule.forRoot({ channels: [], carriers })] })
      .useMocker(token =>
        token === PinoLogger ? { setContext: jest.fn(), info: jest.fn() } : undefined
      )
      .compile()

  it('registers a carrier that is a plain object, as the local courier is', async () => {
    const moduleRef = await compile([localCarrierPlugin])
    await moduleRef.init()
    expect(moduleRef.get(CarrierRegistry).get(CarrierId.LOCAL)).toBe(localCarrierPlugin)
    await moduleRef.close()
  })

  it('registers a carrier that is a class the container builds', async () => {
    @Injectable()
    class ClassCarrier implements CarrierPlugin {
      readonly id = CarrierId.LOCAL
      readonly name = localCarrierPlugin.name
      readonly version = localCarrierPlugin.version
      readonly author = localCarrierPlugin.author
      readonly type = localCarrierPlugin.type
      readonly capabilities = localCarrierPlugin.capabilities
      readonly shipmentCreation = localCarrierPlugin.shipmentCreation
      serviceCatalog = () => localCarrierPlugin.serviceCatalog()
      statusCatalog = () => localCarrierPlugin.statusCatalog()
      connect = (input: CarrierConnectInput) => localCarrierPlugin.connect(input)
      disconnect = (ctx: CarrierContext) => localCarrierPlugin.disconnect(ctx)
      healthCheck = (ctx: CarrierContext) => localCarrierPlugin.healthCheck(ctx)
      buildLabelLayout = (input: LabelInput) => this.layout(input)
      private layout(input: LabelInput) {
        if (localCarrierPlugin.buildLabelLayout === undefined)
          throw new Error('the local courier lays out its label')
        return localCarrierPlugin.buildLabelLayout(input)
      }
    }
    const moduleRef = await compile([ClassCarrier])
    await moduleRef.init()
    expect(moduleRef.get(CarrierRegistry).get(CarrierId.LOCAL)).toBeInstanceOf(ClassCarrier)
    await moduleRef.close()
  })

  it('refuses two carriers with the same id, so that the boot fails', async () => {
    await expect(compile([localCarrierPlugin, { ...localCarrierPlugin }])).rejects.toThrow(
      'Carrier local already registered'
    )
  })
})
