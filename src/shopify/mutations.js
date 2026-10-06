/**
 * All GraphQL documents in one place, pinned against the config's apiVersion
 * (default 2026-07 — input shapes verified against the 2026-07 schema docs).
 * If Shopify renames a field in a future version, this is the only file to
 * touch. Verify against https://shopify.dev/docs/api/admin-graphql — append
 * ".txt" to any reference URL for a clean machine-readable version.
 */

export const PRODUCT_SET = /* GraphQL */ `
mutation productSet($input: ProductSetInput!, $synchronous: Boolean!) {
  productSet(input: $input, synchronous: $synchronous) {
    product { id handle variants(first: 100) { nodes { id sku } } }
    productSetOperation { id status }
    userErrors { field message code }
  }
}`;

/** Used inside bulkOperationRunMutation — result fields are delivered via the bulk result JSONL. */
export const PRODUCT_SET_BULK = /* GraphQL */ `
mutation productSet($input: ProductSetInput!, $synchronous: Boolean!) {
  productSet(input: $input, synchronous: $synchronous) {
    product { id handle }
    userErrors { field message code }
  }
}`;

export const CUSTOMER_SET = /* GraphQL */ `
mutation customerSet($input: CustomerSetInput!, $identifier: CustomerSetIdentifiers) {
  customerSet(input: $input, identifier: $identifier) {
    customer { id email }
    userErrors { field message code }
  }
}`;

/** CustomerSetInput has no metafields — land CVR/EAN (and similar) after customerSet. */
export const METAFIELDS_SET = /* GraphQL */ `
mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id namespace key }
    userErrors { field message code }
  }
}`;

export const ORDER_CREATE = /* GraphQL */ `
mutation orderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) {
    order { id name }
    userErrors { field message }
  }
}`;

export const DISCOUNT_CREATE = /* GraphQL */ `
mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
    codeDiscountNode { id }
    userErrors { field message code }
  }
}`;

export const COLLECTION_CREATE = /* GraphQL */ `
mutation collectionCreate($input: CollectionInput!) {
  collectionCreate(input: $input) {
    collection { id handle }
    userErrors { field message }
  }
}`;

export const COLLECTION_CREATE_CONDITIONS = /* GraphQL */ `
mutation collectionCreate($collection: CollectionCreateInput!) {
  collectionCreate(collection: $collection) {
    collection { id handle }
    userErrors { field message }
  }
}`;

export const COLLECTION_ADD_PRODUCTS = /* GraphQL */ `
mutation collectionAddProductsV2($id: ID!, $productIds: [ID!]!) {
  collectionAddProductsV2(id: $id, productIds: $productIds) {
    job { id }
    userErrors { field message }
  }
}`;

/** Online Store (and other channels). Collections created via CollectionCreateInput start unpublished. */
export const PUBLISHABLE_PUBLISH = /* GraphQL */ `
mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) {
    publishable { ... on Collection { id } }
    userErrors { field message }
  }
}`;

export const BLOG_CREATE = /* GraphQL */ `
mutation blogCreate($blog: BlogCreateInput!) {
  blogCreate(blog: $blog) {
    blog { id handle }
    userErrors { field message code }
  }
}`;

export const ARTICLE_CREATE = /* GraphQL */ `
mutation articleCreate($article: ArticleCreateInput!) {
  articleCreate(article: $article) {
    article { id handle }
    userErrors { field message code }
  }
}`;

export const PAGE_CREATE = /* GraphQL */ `
mutation pageCreate($page: PageCreateInput!) {
  pageCreate(page: $page) {
    page { id handle }
    userErrors { field message code }
  }
}`;

export const STAGED_UPLOADS_CREATE = /* GraphQL */ `
mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

export const BULK_RUN_MUTATION = /* GraphQL */ `
mutation bulkOperationRunMutation($mutation: String!, $stagedUploadPath: String!) {
  bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
    bulkOperation { id status }
    userErrors { field message code }
  }
}`;

export const BULK_OP_BY_ID = /* GraphQL */ `
query bulkOperation($id: ID!) {
  bulkOperation(id: $id) { id status errorCode objectCount url partialDataUrl }
}`;
/** Fallback for API versions < 2026-01 where bulkOperation(id:) doesn't exist. */
export const CURRENT_BULK_MUTATION = /* GraphQL */ `
query { currentBulkOperation(type: MUTATION) { id status errorCode objectCount url partialDataUrl } }`;

export const URL_REDIRECT_IMPORT_CREATE = /* GraphQL */ `
mutation urlRedirectImportCreate($url: URL!) {
  urlRedirectImportCreate(url: $url) {
    urlRedirectImport { id }
    userErrors { field message }
  }
}`;

export const URL_REDIRECT_IMPORT_SUBMIT = /* GraphQL */ `
mutation urlRedirectImportSubmit($id: ID!) {
  urlRedirectImportSubmit(id: $id) {
    job { id done }
    userErrors { field message }
  }
}`;

export const URL_REDIRECT_IMPORT_STATUS = /* GraphQL */ `
query urlRedirectImport($id: ID!) {
  urlRedirectImport(id: $id) { id finished createdCount updatedCount failedCount }
}`;
/** Fallback if updatedCount doesn't exist on this API version. */
export const URL_REDIRECT_IMPORT_STATUS_BASIC = /* GraphQL */ `
query urlRedirectImport($id: ID!) {
  urlRedirectImport(id: $id) { id finished createdCount failedCount }
}`;

export const QUERY_BLOGS = /* GraphQL */ `query { blogs(first: 50) { nodes { id handle title } } }`;
export const QUERY_PAGES_BY_HANDLE = /* GraphQL */ `query pages($q: String!) { pages(first: 1, query: $q) { nodes { id handle } } }`;
export const QUERY_COLLECTION_BY_HANDLE = /* GraphQL */ `query collectionByHandle($handle: String!) { collectionByHandle(handle: $handle) { id handle } }`;
/** APP catalogs only — Online Store is the one whose app handle is online_store. */
export const QUERY_PUBLICATIONS = /* GraphQL */ `
query publications {
  publications(first: 20, catalogType: APP) {
    nodes {
      id
      supportsFuturePublishing
      catalog {
        ... on AppCatalog {
          apps(first: 5) { nodes { handle } }
        }
      }
    }
  }
}`;
export const QUERY_COUNTS = /* GraphQL */ `
query {
  productsCount { count }
  customersCount { count }
  ordersCount(limit: 10000) { count precision }
  collectionsCount { count }
}`;
export const QUERY_VARIANT_BY_SKU = /* GraphQL */ `
query variantBySku($q: String!) {
  productVariants(first: 2, query: $q) { nodes { id sku price product { id handle title } } }
}`;
export const QUERY_PRODUCTS_BY_TAG = /* GraphQL */ `
query productsByTag($q: String!) {
  products(first: 1, query: $q) { nodes { id handle tags variants(first: 1) { nodes { sku price } } } }
}`;
export const QUERY_ORDERS_BY_TAG = /* GraphQL */ `
query ordersByTag($q: String!) {
  orders(first: 10, query: $q) { nodes { id name tags createdAt } }
}`;
export const QUERY_PCD_PROBE = /* GraphQL */ `{ customers(first: 1) { nodes { id } } }`;
export const ORDER_DELETE = /* GraphQL */ `
mutation orderDelete($orderId: ID!) {
  orderDelete(orderId: $orderId) { deletedId userErrors { field message } }
}`;

// ---- wipe (dev stores only — see stages/wipe.js) ----
export const PRODUCT_DELETE = /* GraphQL */ `
mutation productDelete($input: ProductDeleteInput!) {
  productDelete(input: $input) { deletedProductId userErrors { field message } }
}`;
export const COLLECTION_DELETE = /* GraphQL */ `
mutation collectionDelete($input: CollectionDeleteInput!) {
  collectionDelete(input: $input) { deletedCollectionId userErrors { field message } }
}`;
export const CUSTOMER_DELETE = /* GraphQL */ `
mutation customerDelete($id: ID!) {
  customerDelete(input: { id: $id }) { deletedCustomerId userErrors { field message } }
}`;
export const DISCOUNT_DELETE = /* GraphQL */ `
mutation discountCodeDelete($id: ID!) {
  discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { field message } }
}`;
export const ARTICLE_DELETE = /* GraphQL */ `
mutation articleDelete($id: ID!) {
  articleDelete(id: $id) { deletedArticleId userErrors { field message } }
}`;
export const BLOG_DELETE = /* GraphQL */ `
mutation blogDelete($id: ID!) {
  blogDelete(id: $id) { deletedBlogId userErrors { field message } }
}`;
export const PAGE_DELETE = /* GraphQL */ `
mutation pageDelete($id: ID!) {
  pageDelete(id: $id) { deletedPageId userErrors { field message } }
}`;
export const URL_REDIRECT_DELETE = /* GraphQL */ `
mutation urlRedirectDelete($id: ID!) {
  urlRedirectDelete(id: $id) { deletedUrlRedirectId userErrors { field message } }
}`;
export const URL_REDIRECT_BULK_DELETE_ALL = /* GraphQL */ `
mutation { urlRedirectBulkDeleteAll { job { id } userErrors { field message } } }`;

// ---- P4 flag-gated importers (DanDomain) ----
export const REFUND_CREATE = /* GraphQL */ `
mutation refundCreate($input: RefundInput!, $idempotencyKey: String!) {
  refundCreate(input: $input) @idempotent(key: $idempotencyKey) {
    refund { id }
    userErrors { field message }
  }
}`;

export const GIFT_CARD_CREATE = /* GraphQL */ `
mutation giftCardCreate($input: GiftCardCreateInput!) {
  giftCardCreate(input: $input) {
    giftCard { id initialValue { amount } balance { amount } }
    userErrors { field message code }
  }
}`;

export const TRANSLATIONS_REGISTER = /* GraphQL */ `
mutation translationsRegister($resourceId: ID!, $translations: [TranslationInput!]!) {
  translationsRegister(resourceId: $resourceId, translations: $translations) {
    translations { key value locale }
    userErrors { field message }
  }
}`;

/** Context7 /websites/shopify_dev_api_admin-graphql_2026-01: translatableResource(resourceId: ID!). */
export const QUERY_TRANSLATABLE_RESOURCE = /* GraphQL */ `
query translatableResource($resourceId: ID!) {
  translatableResource(resourceId: $resourceId) {
    resourceId
    translatableContent { key digest locale }
  }
}`;

export const CATALOG_CREATE = /* GraphQL */ `
mutation catalogCreate($input: CatalogCreateInput!) {
  catalogCreate(input: $input) {
    catalog { id title }
    userErrors { field message code }
  }
}`;

export const PRICE_LIST_CREATE = /* GraphQL */ `
mutation priceListCreate($input: PriceListCreateInput!) {
  priceListCreate(input: $input) {
    priceList { id name }
    userErrors { field message code }
  }
}`;

export const PRICE_LIST_FIXED_PRICES_ADD = /* GraphQL */ `
mutation priceListFixedPricesAdd($priceListId: ID!, $prices: [PriceListPriceInput!]!) {
  priceListFixedPricesAdd(priceListId: $priceListId, prices: $prices) {
    prices { variant { id } price { amount currencyCode } }
    userErrors { field message code }
  }
}`;

export const QUERY_ORDER_TRANSACTIONS = /* GraphQL */ `
query orderTransactions($id: ID!) {
  order(id: $id) {
    id
    transactions(first: 10) { nodes { id kind status gateway } }
  }
}`;

/** Fallback when Order.transactions is a list, not a connection. */
export const QUERY_ORDER_TRANSACTIONS_LIST = /* GraphQL */ `
query orderTransactionsList($id: ID!) {
  order(id: $id) {
    id
    transactions { id kind status gateway }
  }
}`;

export const COMPANY_CREATE = /* GraphQL */ `
mutation companyCreate($input: CompanyCreateInput!) {
  companyCreate(input: $input) {
    company {
      id
      name
      locations(first: 1) {
        nodes { id }
        edges { node { id } }
      }
    }
    userErrors { field message code }
  }
}`;

/** Wipe does not delete companies; resume lookups by externalId (2026-01 companies query). */
export const QUERY_COMPANIES = /* GraphQL */ `
query companies($query: String!) {
  companies(first: 5, query: $query) {
    nodes {
      id
      name
      externalId
      locations(first: 1) {
        nodes { id }
        edges { node { id } }
      }
    }
  }
}`;

export const QUERY_SHOP_CURRENCY = /* GraphQL */ `
query shopCurrency { shop { currencyCode } }`;

export const QUERY_GIFT_CARDS = /* GraphQL */ `
query giftCards($query: String!) {
  giftCards(first: 5, query: $query) {
    nodes { id }
  }
}`;

export const QUERY_SHOP_LOCALES = /* GraphQL */ `
query shopLocales {
  shopLocales { locale primary published }
}`;

export const SHOP_LOCALE_ENABLE = /* GraphQL */ `
mutation shopLocaleEnable($locale: String!) {
  shopLocaleEnable(locale: $locale) {
    shopLocale { locale published }
    userErrors { field message }
  }
}`;

export const SHOP_LOCALE_UPDATE = /* GraphQL */ `
mutation shopLocaleUpdate($locale: String!, $shopLocale: ShopLocaleInput!) {
  shopLocaleUpdate(locale: $locale, shopLocale: $shopLocale) {
    shopLocale { locale published }
    userErrors { field message }
  }
}`;
