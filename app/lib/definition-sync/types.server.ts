export const TOKEN_STATUSES = ["unchecked", "valid", "invalid"] as const;
export const JOB_STATUSES = [
  "pending",
  "scanning",
  "syncing",
  "completed",
  "failed",
] as const;
export const LOG_STATUSES = [
  "created",
  "exists",
  "skipped",
  "conflict",
  "failed",
] as const;
export const ITEM_TYPES = [
  "metafield_definition",
  "metaobject_definition",
  "metaobject_field",
  "metaobject_entry",
] as const;

export type TokenStatus = (typeof TOKEN_STATUSES)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];
export type LogStatus = (typeof LOG_STATUSES)[number];
export type SyncItemType = (typeof ITEM_TYPES)[number];

export const SUPPORTED_METAFIELD_OWNER_TYPES = [
  "API_PERMISSION",
  "ARTICLE",
  "BLOG",
  "CARTTRANSFORM",
  "COLLECTION",
  "COMPANY",
  "COMPANY_LOCATION",
  "CUSTOMER",
  "DELIVERY_CUSTOMIZATION",
  "DISCOUNT",
  "DRAFTORDER",
  "FULFILLMENT_CONSTRAINT_RULE",
  "GIFT_CARD_TRANSACTION",
  "LOCATION",
  "MARKET",
  "ORDER",
  "ORDER_ROUTING_LOCATION_RULE",
  "PAGE",
  "PAYMENT_CUSTOMIZATION",
  "PRODUCT",
  "PRODUCTVARIANT",
  "SELLING_PLAN",
  "SHOP",
  "VALIDATION",
] as const;

export interface GraphqlUserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

export interface ValidationRule {
  name: string;
  value?: string | null;
  type?: string | null;
}

export interface MetafieldDefinitionRecord {
  id?: string;
  name: string;
  namespace: string;
  key: string;
  ownerType: string;
  type: string;
  description?: string | null;
  validations: ValidationRule[];
}

export interface MetaobjectFieldDefinitionRecord {
  key: string;
  name: string;
  type: string;
  description?: string | null;
  required: boolean;
  validations: ValidationRule[];
}

export interface MetaobjectDefinitionRecord {
  id?: string;
  type: string;
  name: string;
  description?: string | null;
  displayNameKey?: string | null;
  access?: { admin: string; storefront: string };
  capabilities?: { publishable?: { enabled: boolean } };
  fieldDefinitions: MetaobjectFieldDefinitionRecord[];
}

export interface OwnerTypeAccessResult {
  ownerType: string;
  accessible: boolean;
  message?: string;
}

export interface MetafieldDefinitionFetchResult {
  definitions: MetafieldDefinitionRecord[];
  ownerTypeAccess: OwnerTypeAccessResult[];
}

export interface MetaobjectDefinitionFetchResult {
  definitions: MetaobjectDefinitionRecord[];
}

export interface MetafieldConflict {
  key: string;
  source: MetafieldDefinitionRecord;
  target: MetafieldDefinitionRecord;
  message: string;
}

export interface MetaobjectFieldConflict {
  key: string;
  source: MetaobjectFieldDefinitionRecord;
  target: MetaobjectFieldDefinitionRecord;
  message: string;
}

export interface MetaobjectComparisonItem {
  type: string;
  source: MetaobjectDefinitionRecord;
  target?: MetaobjectDefinitionRecord;
  missingFields: MetaobjectFieldDefinitionRecord[];
  fieldConflicts: MetaobjectFieldConflict[];
}

export interface DefinitionScanPreview {
  sourceShop: string;
  targetShop: string;
  summary: {
    totalSourceMetafieldDefinitions: number;
    totalTargetMetafieldDefinitions: number;
    missingMetafieldDefinitions: number;
    existingMetafieldDefinitions: number;
    conflictingMetafieldDefinitions: number;
    totalSourceMetaobjectDefinitions: number;
    totalTargetMetaobjectDefinitions: number;
    missingMetaobjectDefinitions: number;
    existingMetaobjectDefinitions: number;
    missingMetaobjectFields: number;
    conflictingMetaobjectFields: number;
  };
  metafields: {
    missing: MetafieldDefinitionRecord[];
    existing: MetafieldDefinitionRecord[];
    conflicts: MetafieldConflict[];
  };
  metaobjects: {
    missing: MetaobjectDefinitionRecord[];
    existing: MetaobjectComparisonItem[];
    conflicts: MetaobjectComparisonItem[];
  };
  ownerTypeWarnings: string[];
}
