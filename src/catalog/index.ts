/**
 * Catalog public surface (spec §2, §3, §4, §13).
 *
 * Import from '@/catalog' rather than reaching into individual modules, so the
 * storefront, admin and seed code all see the same projection, the same pricing
 * engine and the same invalidation hooks.
 *
 * The module graph is acyclic and layered:
 *
 *   cache-control   (no catalog deps)
 *        ^
 *   availability <--- queries <--- amazon
 *        ^                 ^
 *   validation      pricing (depends on neither)
 */

export {
  PUBLIC_PRODUCT_SELECT,
  toPublicProduct,
  listActiveProducts,
  getProductBySlug,
  getProductById,
  listCatalogFacets,
  invalidateCatalogCache,
  type ProductRow,
  type PublicProduct,
  type ListProductsOptions,
} from './queries';

export {
  computePricing,
  computePricingForProduct,
  assertPublishable,
  selectPricingRule,
  effectivePricingRule,
  defaultPricingRule,
  validatePricingInput,
  suggestSellingPrice,
  getSellingPriceTier,
  loadPricingRules,
  evaluateProductPricing,
  evaluateStoredProduct,
  DEFAULT_SELLING_PRICE_TIERS,
  DEFAULT_MIN_DISCOUNT_BPS,
  DEFAULT_MIN_MARGIN_BPS,
  type PricingInput,
  type PricingResult,
  type PricingRuleInput,
  type SellingPriceTier,
  type SellingPriceSuggestion,
} from './pricing';

export {
  deriveAvailability,
  availableInventoryWhere,
  countAvailableInventory,
  getAvailability,
  getAvailabilityForProducts,
  recomputeInventoryCount,
  adjustInventoryCount,
  assertPurchasable,
  type Availability,
  type AvailabilitySnapshot,
  type AvailableInventoryOptions,
  type CatalogDb,
} from './availability';

export {
  catalogCache,
  catalogCacheStatus,
  catalogTtlSeconds,
  resetCatalogCacheForTests,
  DEFAULT_CATALOG_TTL_SECONDS,
  type CatalogCache,
  type CatalogCacheTier,
} from './cache-control';

export {
  productCreateSchema,
  productUpdateSchema,
  parseProductCreate,
  parseProductUpdate,
  parseInventoryCsv,
  formatZodError,
  MAX_IMPORT_ROWS,
  MAX_CSV_BYTES,
  MAX_LINE_LENGTH,
  MAX_CODE_LENGTH,
  MIN_CODE_LENGTH,
  type ProductCreateInput,
  type ProductUpdateInput,
  type ParsedInventoryRow,
  type InventoryCsvError,
  type InventoryCsvParseResult,
} from './validation';

export {
  AMAZON_BRAND,
  AMAZON_SLUG_PREFIX,
  AMAZON_FACE_VALUE_HINT,
  isAmazonProduct,
  amazonSlug,
  slugify,
  buildAmazonProductDisplay,
  amazonDisplayFromPublicProduct,
  selectAmazonProducts,
  toAmazonProductDraft,
  type AmazonProductInput,
  type AmazonProductDisplay,
  type AmazonProductDraft,
} from './amazon';