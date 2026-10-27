/** datetime-local is a wall clock value, not UTC. Browsers may include seconds. */
export function contactDateFromInput(value: string): string {
  if (!value) return "";
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value)) return "";
  return `${value.slice(0, 16)}:00+03:00`;
}

export function contactDateToInput(value: string): string {
  if (!value || Number.isNaN(Date.parse(value))) return "";
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value));
  const p = (type: Intl.DateTimeFormatPartTypes) => parts.find(x => x.type === type)?.value;
  return `${p("year")}-${p("month")}-${p("day")}T${p("hour")}:${p("minute")}`;
}
