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
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { actorOf, CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

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
import type {
  ProductDetail,
  ProductImageView,
  ProductPage,
  ProductSuggestions,
  VariantView
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
  list(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(listProductsQuerySchema)) query: ListProductsQuery
  ): Promise<ProductPage> {
    return this.products.list(store.id, query)
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
  create(
    @CurrentStore() store: { id: string },
    @Body(new ZodValidationPipe(createProductSchema)) body: CreateProductBody
  ): Promise<ProductDetail> {
    return this.products.create(store.id, body)
  }

  @RequirePermissions(Permissions.PRODUCTS_VIEW)
  @Get(ApiRoutes.products.byId(':id'))
  get(
    @CurrentStore() store: { id: string },
    @Param('id', id()) productId: string
  ): Promise<ProductDetail> {
    return this.products.get(store.id, productId)
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
  update(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) productId: string,
    @Body(new ZodValidationPipe(updateProductSchema)) body: UpdateProductBody,
    @Req() req: AuthenticatedRequest
  ): Promise<ProductDetail> {
    return this.products.update(store.id, productId, body, actorOf(user, store, req))
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
  createVariant(
    @CurrentStore() store: { id: string },
    @Param('id', id()) productId: string,
    @Body(new ZodValidationPipe(createVariantSchema)) body: CreateVariantBody
  ): Promise<VariantView> {
    return this.variants.create(store.id, productId, body)
  }

  @RequirePermissions(Permissions.PRODUCTS_EDIT)
  @Patch(ApiRoutes.products.variantById(':id', ':variantId'))
  updateVariant(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) productId: string,
    @Param('variantId', id()) variantId: string,
    @Body(new ZodValidationPipe(updateVariantSchema)) body: UpdateVariantBody,
    @Req() req: AuthenticatedRequest
  ): Promise<VariantView> {
    return this.variants.update(store.id, productId, variantId, body, actorOf(user, store, req))
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
