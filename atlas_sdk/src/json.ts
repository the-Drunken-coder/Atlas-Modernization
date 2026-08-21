const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

export function parseAtlasJSON(serialized: string): unknown {
  rejectUnsafeJSONNumbers(serialized);
  return JSON.parse(serialized);
}

export function stringifyAtlasJSON(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    const number = typeof item === "number" ? item : boxedNumberValue(item);
    if (number !== undefined) assertSafeJSONNumber(number);
    return item;
  });
  if (serialized === undefined) throw new TypeError("Atlas request body is not JSON serializable");
  rejectUnsafeJSONNumbers(serialized);
  return serialized;
}

function boxedNumberValue(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!(value instanceof Number) && Object.prototype.toString.call(value) !== "[object Number]") return undefined;
  return Number.prototype.valueOf.call(value);
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
        assertSafeJSONNumber(Number(match[0]));
        index = JSON_NUMBER.lastIndex;
        continue;
      }
    }
    index++;
  }
}

function assertSafeJSONNumber(value: number): void {
  if (!Number.isFinite(value)) throw new TypeError("Atlas JSON contains a number outside the JavaScript range");
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new TypeError("Atlas JSON contains an integer that JavaScript cannot represent exactly");
  }
}
