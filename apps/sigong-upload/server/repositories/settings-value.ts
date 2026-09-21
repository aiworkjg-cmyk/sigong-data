// Azure Table strings are limited to 64 KiB per property. Keep a large roster
// in one entity (one atomic write), split over bounded UTF-16 properties.
export function encodeSettingsValue(value: string): Record<string, string | number> {
  if (value.length * 2 > 900_000) throw new Error('설정 데이터가 저장 한도를 초과했습니다.');
  if (value.length <= 30_000) return { value };
  const parts: Record<string, string | number> = {};
  let start = 0, index = 0;
  while (start < value.length) {
    let end = Math.min(start + 30_000, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
    parts[`valuePart${index++}`] = value.slice(start, end);
    start = end;
  }
  parts.valuePartCount = index;
  return parts;
}
export function decodeSettingsValue(entity: Record<string, unknown>): string | null {
  if (typeof entity.value === 'string') return entity.value;
  const count = Number(entity.valuePartCount);
  if (!Number.isInteger(count) || count < 1 || count > 30) return null;
  const parts: string[] = [];
  for (let index = 0; index < count; index++) {
    const part = entity[`valuePart${index}`];
    if (typeof part !== 'string') throw new Error('저장된 설정 데이터 일부를 읽을 수 없습니다.');
    parts.push(part);
  }
  return parts.join('');
}
