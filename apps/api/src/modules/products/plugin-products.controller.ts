import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req
} from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import type { Viewer } from '@platform/core/messaging'
import { PluginScopes } from '@platform/plugins/sdk'

import {
  CurrentPluginInstallation,
  CurrentPluginViewer,
  PluginApi
} from '../plugins/plugin-api.decorators'
import { CurrentStore, mayViewCost, pluginActorOf, RequirePermissions } from '../tenancy'

import { ProductSearchService } from './product-search.service'
import { ProductVariantsService } from './product-variants.service'
import {
  type CreateProductBody,
  createProductSchema,
  type CreateVariantBody,
  createVariantSchema,
  idSchema,
  type ListProductsQuery,
  listProductsQuerySchema,
  type SearchProductsQuery,
  searchProductsQuerySchema,
  type UpdateProductBody,
  updateProductSchema,
  type UpdateVariantBody,
  updateVariantSchema
} from './products.schemas'
import { ProductsService } from './products.service'
import { assertMayWriteCost, assertMayWriteTax } from './products.support'
import {
  type ProductDetail,
  type ProductImageView,
  type ProductPage,
  type ProductSuggestions,
  redactDetail,
  redactPage,
  redactVariant,
  type VariantView
} from './products.views'

const id = () => new ZodValidationPipe(idSchema)

type Installation = { id: string; pluginId: string }
type Store = { id: string }

const READ = PluginScopes.PRODUCTS_READ
const WRITE = PluginScopes.PRODUCTS_WRITE
const DELETE = PluginScopes.PRODUCTS_DELETE

// The catalog of the store of the key (Step 5.6 PR E4a), over the same services as the screen. Every route holds `products:read`,
// even a write: a key must not learn that a product exists (the 404 of a change or a delete) through a scope it was not given. A
// write takes `products:write` besides (create and edit), and deleting a product or a variant takes `products:delete`, because
// no other scope grants that permission. The permissions a method asks for are those of the same route of the screen, checked by
// the guard against the scopes of THE ROUTE. The cost and the tax have permissions that no scope grants, so a plugin never reads a
// cost (`redactDetail`, `redactPage`: the viewer holds no PRODUCTS_VIEW_COST), and a body that sets a cost or a tax is refused
// (`assertMayWriteCost`, `assertMayWriteTax`); how a product is taxed (`taxTreatment`, `taxRateId`) is part of its price and is read
// as on the screen. The audit entries of the catalog (price, cost, tax and delete with their values, and the general `product.created` and
// `product.updated` with the names of the fields set, `auditProductWrite`) name the installation as the system (`pluginActorOf`),
// as they name the person for a screen. The catalog stores no person on a product.
@Controller()
export class PluginProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly variants: ProductVariantsService,
    private readonly productSearch: ProductSearchService
  ) {}

  @PluginApi(READ)
  @RequirePermissions(Permissions.PRODUCTS_VIEW)
  @Get(PluginApiRoutes.products.list)
  async list(
    @CurrentStore() store: Store,
    @CurrentPluginViewer() viewer: Viewer,
    @Query(new ZodValidationPipe(listProductsQuerySchema)) query: ListProductsQuery
  ): Promise<ProductPage> {
    const page = await this.products.list(store.id, query)
    return mayViewCost(viewer.held) ? page : redactPage(page)
  }

  // Declared before `:id`, or "search" would be read as an id
  @PluginApi(READ)
  @RequirePermissions(Permissions.PRODUCTS_VIEW)
  @Get(PluginApiRoutes.products.search)
  search(
    @CurrentStore() store: Store,
    @Query(new ZodValidationPipe(searchProductsQuerySchema)) query: SearchProductsQuery
  ): Promise<ProductSuggestions> {
    return this.productSearch.search(store.id, query)
  }

  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.PRODUCTS_VIEW, Permissions.PRODUCTS_CREATE)
  @Post(PluginApiRoutes.products.create)
  @HttpCode(HttpStatusCodes.CREATED)
  async create(
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @CurrentPluginViewer() viewer: Viewer,
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductBody,
    @Req() req: AuthenticatedRequest
  ): Promise<ProductDetail> {
    assertMayWriteCost(viewer.held, body)
    assertMayWriteTax(viewer.held, body)
    const created = await this.products.create(
      store.id,
      body,
      pluginActorOf(installation, store, req)
    )
    return mayViewCost(viewer.held) ? created : redactDetail(created)
  }

  @PluginApi(READ)
  @RequirePermissions(Permissions.PRODUCTS_VIEW)
  @Get(PluginApiRoutes.products.byId(':id'))
  async get(
    @CurrentStore() store: Store,
    @CurrentPluginViewer() viewer: Viewer,
    @Param('id', id()) productId: string
  ): Promise<ProductDetail> {
    const product = await this.products.get(store.id, productId)
    return mayViewCost(viewer.held) ? product : redactDetail(product)
  }

  @PluginApi(READ)
  @RequirePermissions(Permissions.PRODUCTS_VIEW)
  @Get(PluginApiRoutes.products.images(':id'))
  images(
    @CurrentStore() store: Store,
    @Param('id', id()) productId: string
  ): Promise<ProductImageView[]> {
    return this.products.images(store.id, productId)
  }

  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.PRODUCTS_VIEW, Permissions.PRODUCTS_EDIT)
  @Patch(PluginApiRoutes.products.byId(':id'))
  async update(
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @CurrentPluginViewer() viewer: Viewer,
    @Param('id', id()) productId: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductBody,
    @Req() req: AuthenticatedRequest
  ): Promise<ProductDetail> {
    assertMayWriteCost(viewer.held, body)
    assertMayWriteTax(viewer.held, body)
    const updated = await this.products.update(
      store.id,
      productId,
      body,
      pluginActorOf(installation, store, req)
    )
    return mayViewCost(viewer.held) ? updated : redactDetail(updated)
  }

  @PluginApi(READ, DELETE)
  @RequirePermissions(Permissions.PRODUCTS_VIEW, Permissions.PRODUCTS_DELETE)
  @Delete(PluginApiRoutes.products.byId(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async remove(
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @Param('id', id()) productId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    await this.products.remove(store.id, productId, pluginActorOf(installation, store, req))
  }

  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.PRODUCTS_VIEW, Permissions.PRODUCTS_CREATE)
  @Post(PluginApiRoutes.products.variants(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  async createVariant(
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @CurrentPluginViewer() viewer: Viewer,
    @Param('id', id()) productId: string,
    @Body(new ZodValidationPipe(createVariantSchema)) body: CreateVariantBody,
    @Req() req: AuthenticatedRequest
  ): Promise<VariantView> {
    assertMayWriteCost(viewer.held, body)
    const created = await this.variants.create(
      store.id,
      productId,
      body,
      pluginActorOf(installation, store, req)
    )
    return mayViewCost(viewer.held) ? created : redactVariant(created)
  }

  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.PRODUCTS_VIEW, Permissions.PRODUCTS_EDIT)
  @Patch(PluginApiRoutes.products.variantById(':id', ':variantId'))
  async updateVariant(
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @CurrentPluginViewer() viewer: Viewer,
    @Param('id', id()) productId: string,
    @Param('variantId', id()) variantId: string,
    @Body(new ZodValidationPipe(updateVariantSchema)) body: UpdateVariantBody,
    @Req() req: AuthenticatedRequest
  ): Promise<VariantView> {
    assertMayWriteCost(viewer.held, body)
    const updated = await this.variants.update(
      store.id,
      productId,
      variantId,
      body,
      pluginActorOf(installation, store, req)
    )
    return mayViewCost(viewer.held) ? updated : redactVariant(updated)
  }

  @PluginApi(READ, DELETE)
  @RequirePermissions(Permissions.PRODUCTS_VIEW, Permissions.PRODUCTS_DELETE)
  @Delete(PluginApiRoutes.products.variantById(':id', ':variantId'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async removeVariant(
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @Param('id', id()) productId: string,
    @Param('variantId', id()) variantId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    await this.variants.remove(
      store.id,
      productId,
      variantId,
      pluginActorOf(installation, store, req)
    )
  }
}
