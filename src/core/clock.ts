/** 时间戳 → 本地 HH:MM。用户看的是"几点同步的"，不是 ISO 串。 */
export function clockTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}