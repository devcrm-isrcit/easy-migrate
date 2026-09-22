import type { ValidationRule } from "../definition-sync/types.shared";

/**
 * Bump when a change would make an older importer misread a newer file.
 * Adding a column is backwards compatible (readers address columns by header
 * name, not position), so it does not need a bump.
 */
export const CSV_FORMAT_VERSION = "1";

export const CSV_RECORD_TYPES = [
  "export_meta",
  "owner_type_access",
  "metafield_definition",
  "metaobject_definition",
  "metaobject_field",
] as const;

export type CsvRecordType = (typeof CSV_RECORD_TYPES)[number];

export const CSV_COLUMNS = [
  "record_type",
  "owner_type",
  "namespace",
  "key",
  "metaobject_type",
  "name",
  "type",
  "required",
  "description",
  "display_name_key",
  "admin_access",
  "storefront_access",
  "publishable",
  "source_id",
  "validations",
  "value",
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];
export type CsvRow = Partial<Record<CsvColumn, string>>;

export const META_KEYS = {
  formatVersion: "format_version",
  sourceShop: "source_shop",
  exportedAt: "exported_at",
} as const;

export function headerRow(): string[] {
  return [...CSV_COLUMNS];
}

export function serializeRow(row: CsvRow): string[] {
  return CSV_COLUMNS.map((column) => row[column] ?? "");
}

export function encodeValidations(validations: ValidationRule[]): string {
  if (!validations.length) {
    return "[]";
  }

  return JSON.stringify(
    validations.map((validation) => ({
      name: validation.name,
      value: validation.value ?? null,
      ...(validation.type ? { type: validation.type } : {}),
    })),
  );
}

export interface ValidationDecodeResult {
  validations: ValidationRule[];
  error: string | null;
}

export function decodeValidations(raw: string | undefined): ValidationDecodeResult {
  const text = (raw ?? "").trim();

  if (!text) {
    return { validations: [], error: null };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      validations: [],
      error: "`validations` is not valid JSON. Expected a JSON array, for example []",
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      validations: [],
      error: "`validations` must be a JSON array.",
    };
  }

  const validations: ValidationRule[] = [];

  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      return {
        validations: [],
        error: "Every entry in `validations` must be a JSON object.",
      };
    }

    const candidate = entry as Record<string, unknown>;

    if (typeof candidate.name !== "string" || !candidate.name) {
      return {
        validations: [],
        error: "Every entry in `validations` needs a non-empty `name`.",
      };
    }

    validations.push({
      name: candidate.name,
      value: typeof candidate.value === "string" ? candidate.value : null,
      type: typeof candidate.type === "string" ? candidate.type : null,
    });
  }

  return { validations, error: null };
}

const TRUE_VALUES = new Set(["true", "yes", "1"]);
const FALSE_VALUES = new Set(["false", "no", "0", ""]);

export function encodeBoolean(value: boolean | undefined | null): string {
  return value ? "true" : "false";
}

export function decodeBoolean(
  raw: string | undefined,
): { value: boolean; error: string | null } {
  const text = (raw ?? "").trim().toLowerCase();

  if (TRUE_VALUES.has(text)) {
    return { value: true, error: null };
  }

  if (FALSE_VALUES.has(text)) {
    return { value: false, error: null };
  }

  return { value: false, error: `Expected true or false, got "${raw ?? ""}".` };
}
