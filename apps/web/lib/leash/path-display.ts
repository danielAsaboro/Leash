export function displayPathMiddle(value: string, head = 12, tail = 18): string {
  if (value.length <= head + tail + 5) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
