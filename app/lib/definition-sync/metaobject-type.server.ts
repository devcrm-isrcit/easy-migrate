const APP_OWNED_METAOBJECT_TYPE_PATTERN = /^app--\d+--(.+)$/;

export function getMetaobjectTypeLogicalKey(type: string) {
  const match = type.match(APP_OWNED_METAOBJECT_TYPE_PATTERN);
  if (match) {
    return match[1];
  }

  if (type.startsWith("$app:")) {
    return type.slice(5);
  }

  return type;
}

export function toMetaobjectDefinitionCreateType(type: string) {
  return `$app:${getMetaobjectTypeLogicalKey(type)}`;
}

export function isAppReservedMetaobjectType(type: string) {
  return type.startsWith("$app:") || APP_OWNED_METAOBJECT_TYPE_PATTERN.test(type);
}
