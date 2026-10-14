// Guards for the JSON data shapes validated and later canonicalized.
export type JsonObject = Record<string, unknown>

function ownEnumerableData(value: object, key: PropertyKey): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return !!descriptor && descriptor.enumerable === true && Object.hasOwn(descriptor, 'value')
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && ownEnumerableData(value, key))
}

export function isJsonArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
  // Only length and dense own data indices can be represented by JSON arrays.
  if (Reflect.ownKeys(value).length !== value.length + 1) return false
  for (let i = 0; i < value.length; i++) {
    if (!ownEnumerableData(value, String(i))) return false
  }
  return true
}
