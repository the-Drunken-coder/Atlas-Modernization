const JSON_NUMBER = /(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?/y;

export function parseAtlasJSON(serialized: string): unknown {
  rejectUnsafeJSONNumbers(serialized);
  return JSON.parse(serialized);
}

export function stringifyAtlasJSON(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    const number = numberValueForSerialization(item);
    if (number === undefined) return item;
    assertAtlasJSONNumber(number);
    return number;
  });
  if (serialized === undefined) throw new TypeError("Atlas request body is not JSON serializable");
  rejectUnsafeJSONNumbers(serialized);
  return serialized;
}

function numberValueForSerialization(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value !== "object" || value === null) return undefined;
  // This intrinsic brand check works across realms and ignores Symbol.toStringTag.
  try {
    Number.prototype.valueOf.call(value);
  } catch {
    return undefined;
  }
  // Return the checked coercion so JSON.stringify cannot invoke custom coercion again.
  return +(value as unknown as number);
}

function rejectUnsafeJSONNumbers(serialized: string): void {
  for (let index = 0; index < serialized.length; ) {
    const character = serialized[index];
    if (character === '"') {
      index++;
      while (index < serialized.length) {
        if (serialized[index] === "\\") {
          index += 2;
          continue;
        }
        if (serialized[index++] === '"') break;
      }
      continue;
    }
    if (character === "-" || (character !== undefined && character >= "0" && character <= "9")) {
      JSON_NUMBER.lastIndex = index;
      const match = JSON_NUMBER.exec(serialized);
      if (match) {
        assertAtlasJSONNumber(Number(match[0]), match);
        index = JSON_NUMBER.lastIndex;
        continue;
      }
    }
    index++;
  }
}

function assertAtlasJSONNumber(value: number, match?: RegExpExecArray): void {
  if (!Number.isFinite(value)) throw new TypeError("Atlas JSON contains a number outside the JavaScript range");
  const exactInteger = match === undefined ? undefined : exactIntegerValue(match);
  if (exactInteger !== undefined && exactInteger !== BigInt(value)) {
    throw new TypeError("Atlas JSON contains an integer that JavaScript cannot represent exactly");
  }
}

// Fractional lexemes keep JSON's standard Number semantics. Only mathematically integral
// wire values participate in the integer-preservation contract.
function exactIntegerValue(match: RegExpExecArray): bigint | undefined {
  const [, sign = "", whole = "", fraction = "", exponent = "0"] = match;
  const digits = `${whole}${fraction}`;
  if (!/[1-9]/.test(digits)) return 0n;

  const decimalPlaces = fraction.length - Number(exponent);
  if (decimalPlaces > 0) {
    if (decimalPlaces > digits.length || /[1-9]/.test(digits.slice(-decimalPlaces))) return undefined;
    return BigInt(`${sign}${digits.slice(0, -decimalPlaces)}`);
  }
  return BigInt(`${sign}${digits}${"0".repeat(-decimalPlaces)}`);
}
