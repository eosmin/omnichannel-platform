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

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  actorOf,
  CurrentPermissions,
  CurrentStore,
  mayViewCost,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

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
import { assertMayWriteCost } from './products.support'
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

// The catalog of the store in X-Store-Id. Reading asks for products:view; creating a product or a variant for
// products:create; changing either for products:edit; deleting either for products:delete.
@Controller()
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly variants: ProductVariantsService,
    private readonly productSearch: ProductSearchService
  ) {}

  @RequirePermissions(Permissions.PRODUCTS_VIEW)
  @Get(ApiRoutes.products.list)
  async list(
    @CurrentStore() store: { id: string },
    @CurrentPermissions() held: readonly Permission[],
    @Query(new ZodValidationPipe(listProductsQuerySchema)) query: ListProductsQuery
  ): Promise<ProductPage> {
    const page = await this.products.list(store.id, query)
    return mayViewCost(held) ? page : redactPage(page)
  }

  // Declared before `:id`, or "search" would be read as an id
  @RequirePermissions(Permissions.PRODUCTS_VIEW)
  @Get(ApiRoutes.products.search)
  search(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(searchProductsQuerySchema)) query: SearchProductsQuery
  ): Promise<ProductSuggestions> {
    return this.productSearch.search(store.id, query)
  }

  @RequirePermissions(Permissions.PRODUCTS_CREATE)
  @Post(ApiRoutes.products.create)
  @HttpCode(HttpStatusCodes.CREATED)
  async create(
    @CurrentStore() store: { id: string },
    @CurrentPermissions() held: readonly Permission[],
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductBody
  ): Promise<ProductDetail> {
    assertMayWriteCost(held, body)
    const created = await this.products.create(store.id, body)
    return mayViewCost(held) ? created : redactDetail(created)
  }

  @RequirePermissions(Permissions.PRODUCTS_VIEW)
  @Get(ApiRoutes.products.byId(':id'))
  async get(
    @CurrentStore() store: { id: string },
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) productId: string
  ): Promise<ProductDetail> {
    const product = await this.products.get(store.id, productId)
    return mayViewCost(held) ? product : redactDetail(product)
  }

  @RequirePermissions(Permissions.PRODUCTS_VIEW)
  @Get(ApiRoutes.products.images(':id'))
  images(
    @CurrentStore() store: { id: string },
    @Param('id', id()) productId: string
  ): Promise<ProductImageView[]> {
    return this.products.images(store.id, productId)
  }

  @RequirePermissions(Permissions.PRODUCTS_EDIT)
  @Patch(ApiRoutes.products.byId(':id'))
  async update(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) productId: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductBody,
    @Req() req: AuthenticatedRequest
  ): Promise<ProductDetail> {
    assertMayWriteCost(held, body)
    const updated = await this.products.update(store.id, productId, body, actorOf(user, store, req))
    return mayViewCost(held) ? updated : redactDetail(updated)
  }

  @RequirePermissions(Permissions.PRODUCTS_DELETE)
  @Delete(ApiRoutes.products.byId(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async remove(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) productId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    await this.products.remove(store.id, productId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.PRODUCTS_CREATE)
  @Post(ApiRoutes.products.variants(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  async createVariant(
    @CurrentStore() store: { id: string },
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) productId: string,
    @Body(new ZodValidationPipe(createVariantSchema)) body: CreateVariantBody
  ): Promise<VariantView> {
    assertMayWriteCost(held, body)
    const created = await this.variants.create(store.id, productId, body)
    return mayViewCost(held) ? created : redactVariant(created)
  }

  @RequirePermissions(Permissions.PRODUCTS_EDIT)
  @Patch(ApiRoutes.products.variantById(':id', ':variantId'))
  async updateVariant(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) productId: string,
    @Param('variantId', id()) variantId: string,
    @Body(new ZodValidationPipe(updateVariantSchema)) body: UpdateVariantBody,
    @Req() req: AuthenticatedRequest
  ): Promise<VariantView> {
    assertMayWriteCost(held, body)
    const updated = await this.variants.update(
      store.id,
      productId,
      variantId,
      body,
      actorOf(user, store, req)
    )
    return mayViewCost(held) ? updated : redactVariant(updated)
  }

  @RequirePermissions(Permissions.PRODUCTS_DELETE)
  @Delete(ApiRoutes.products.variantById(':id', ':variantId'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async removeVariant(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) productId: string,
    @Param('variantId', id()) variantId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    await this.variants.remove(store.id, productId, variantId, actorOf(user, store, req))
  }
}
