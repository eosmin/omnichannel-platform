// Importing a controller imports the platform modules, which parse the env of the app: the same base the
// integration suites use
import '../../testing/load-example-env'

import { RequestMethod } from '@nestjs/common'
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'

import { ApiRoutes } from '@platform/core/api'
import { Permissions, ThrottlerNames } from '@platform/core/auth'
import { IS_PUBLIC_KEY } from '@platform/core/auth-module'
import { WidgetThrottle } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'

import { PERMISSIONS_KEY } from '../tenancy/decorators'

import { WidgetSettingsController } from './widget-settings.controller'
import { WidgetController } from './widget.controller'

// The doors of the web widget, pinned as they are exposed: the path, the method, who may call (public on
// purpose, or a permission of the store), the rate limit of each public door and the status of its answer.
// The doors move from the api into the plugin module (Step 7.9, A6b), and a move must not change one of
// them: this spec fails if a path, a method, a guard flag, a limit or a status changes, whichever file
// declares the controller.
function door(controller: { prototype: object }, handler: string) {
  const target = (controller.prototype as Record<string, object>)[handler] as object
  return {
    path: Reflect.getMetadata(PATH_METADATA, target) as string,
    method: Reflect.getMetadata(METHOD_METADATA, target) as RequestMethod,
    status: Reflect.getMetadata(HTTP_CODE_METADATA, target) as number | undefined,
    limit: Reflect.getMetadata(`THROTTLER:LIMIT${ThrottlerNames.DEFAULT}`, target) as
      number | undefined,
    ttl: Reflect.getMetadata(`THROTTLER:TTL${ThrottlerNames.DEFAULT}`, target) as
      number | undefined,
    permissions: Reflect.getMetadata(PERMISSIONS_KEY, target) as string[] | undefined
  }
}

describe('the public doors of the web widget', () => {
  it('is public on purpose, as a whole', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, WidgetController)).toBe(true)
  })

  it.each([
    ['bootstrap', ApiRoutes.widget.bootstrap, WidgetThrottle.BOOTSTRAP],
    ['send', ApiRoutes.widget.messages, WidgetThrottle.MESSAGES],
    ['upload', ApiRoutes.widget.upload, WidgetThrottle.UPLOAD],
    ['download', ApiRoutes.widget.download, WidgetThrottle.DOWNLOAD]
  ])('keeps the path, the method, the status and the limit of %s', (handler, path, limit) => {
    const found = door(WidgetController, handler)

    expect(found).toMatchObject({
      path,
      method: RequestMethod.POST,
      status: HttpStatusCodes.OK,
      limit: limit.limit,
      ttl: limit.ttlMs
    })
  })

  it('has no other door than these four', () => {
    const doors = Object.getOwnPropertyNames(WidgetController.prototype).filter(
      name =>
        Reflect.getMetadata(
          METHOD_METADATA,
          (WidgetController.prototype as unknown as Record<string, object>)[name] as object
        ) !== undefined
    )

    expect(doors.sort()).toEqual(['bootstrap', 'download', 'send', 'upload'])
  })

  it('has the concrete paths the script of a site calls', () => {
    expect([
      ApiRoutes.widget.bootstrap,
      ApiRoutes.widget.messages,
      ApiRoutes.widget.upload,
      ApiRoutes.widget.download
    ]).toEqual([
      '/widget/bootstrap',
      '/widget/messages',
      '/widget/upload-url',
      '/widget/download-url'
    ])
  })
})

describe('the settings routes of the web widget', () => {
  it.each([
    ['embed', ApiRoutes.channels.widgetEmbed(':id'), RequestMethod.GET, Permissions.SETTINGS_VIEW],
    [
      'updateOrigins',
      ApiRoutes.channels.widgetOrigins(':id'),
      RequestMethod.PUT,
      Permissions.SETTINGS_EDIT
    ],
    [
      'updatePreChat',
      ApiRoutes.channels.widgetPreChat(':id'),
      RequestMethod.PUT,
      Permissions.SETTINGS_EDIT
    ]
  ])(
    'asks %s for the permission of the store, behind the guards',
    (handler, path, method, permission) => {
      const found = door(WidgetSettingsController, handler)

      expect(found).toMatchObject({ path, method, permissions: [permission] })
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, WidgetSettingsController)).toBeUndefined()
    }
  )
})
