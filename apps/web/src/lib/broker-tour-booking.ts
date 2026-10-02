/** Tour schedules and form dates always use Moscow, never the browser timezone. */
export const TOUR_TIME_ZONE = 'Europe/Moscow';
export type TourEvent = { id?: string; title?: string; date: string; isActive?: boolean };
export type TourSlot = { date: string; time: string; projects: string[]; startsAt: number };
export type TourBooking = { date: string; time: string; projects: string[] };

const moscow = new Intl.DateTimeFormat('en-GB', {
  timeZone: TOUR_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function moscowDateTime(now = new Date()): { date: string; time: string } {
  const parts = Object.fromEntries(moscow.formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function calendarDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function isCalendarDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(calendarDate(date).getTime())
    && calendarDate(date).toISOString().slice(0, 10) === date;
}

export function addTourDays(date: string, days: number): string {
  const day = calendarDate(date);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

export function tomorrowInMoscow(now = new Date()): string {
  return addTourDays(moscowDateTime(now).date, 1);
}

export function tourWorkWeek(offset = 0, now = new Date()): string[] {
  const date = moscowDateTime(now).date;
  const dow = (calendarDate(date).getUTCDay() + 6) % 7;
  return Array.from({ length: 5 }, (_, index) => addTourDays(date, -dow + offset * 7 + index));
}

export function tourMonthGrid(year: number, month: number): Array<string | null> {
  const first = new Date(Date.UTC(year, month, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const total = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= total; day++) cells.push(new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10));
  while (cells.length % 7) cells.push(null);
  return cells;
}

export function tourProjects(title: string): string[] {
  const raw = String(title || '').replace(/^\s*брокер-тур\s*:?\s*/i, '');
  const result: string[] = [];
  for (const part of raw.split(/\s*[+,\/]\s*/).map(p => p.trim()).filter(Boolean)) {
    const value = part.toLowerCase();
    const project = value.includes('коммерц') ? 'Коммерция Зорге 9'
      : /зорге|zorge/.test(value) ? 'Зорге 9'
        : /сереб|берзар|silver|ксб/.test(value) ? 'Квартал Серебряный Бор' : part;
    if (!result.includes(project)) result.push(project);
  }
  return result;
}

function eventInstant(date: string): number {
  // Legacy CMS timestamps without an offset are Moscow-local, not browser-local.
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(date)
    ? date + '+03:00' : /^\d{4}-\d{2}-\d{2}$/.test(date) ? date + 'T00:00:00+03:00' : date;
  return new Date(normalized).getTime();
}

export function allTourSlots(events: TourEvent[]): TourSlot[] {
  const byMinute = new Map<string, TourSlot>();
  for (const event of events) {
    if (event.isActive === false) continue;
    const startsAt = eventInstant(event.date);
    if (!Number.isFinite(startsAt)) continue;
    const projects = tourProjects(event.title || '');
    if (!projects.length) continue;
    const { date, time } = moscowDateTime(new Date(startsAt));
    const key = `${date}T${time}`;
    const slot = byMinute.get(key) || { date, time, projects: [], startsAt };
    slot.startsAt = Math.min(slot.startsAt, startsAt);
    for (const project of projects) if (!slot.projects.includes(project)) slot.projects.push(project);
    byMinute.set(key, slot);
  }
  return [...byMinute.values()].sort((a, b) => a.startsAt - b.startsAt);
}

export function slotsForTourDay(date: string, events: TourEvent[], now = new Date(), includePast = false): TourSlot[] {
  if (!isCalendarDate(date)) return [];
  const published = allTourSlots(events).filter(slot => slot.date === date);
  const weekday = calendarDate(date).getUTCDay();
  // Existing owner-approved weekday recurrence; dated CMS events override it.
  // A slot is a requested visit, not a capacity guarantee: a manager confirms it.
  const schedule = published.length ? published : weekday === 0 || weekday === 6 ? [] : [
    { date, time: '11:00', projects: ['Квартал Серебряный Бор'], startsAt: new Date(`${date}T11:00:00+03:00`).getTime() },
    { date, time: '15:00', projects: ['Зорге 9', 'Квартал Серебряный Бор'], startsAt: new Date(`${date}T15:00:00+03:00`).getTime() },
  ];
  return schedule.filter(slot => includePast || slot.startsAt >= now.getTime());
}

export function nextTourSlot(events: TourEvent[], after: string, now = new Date()): TourSlot | undefined {
  if (!isCalendarDate(after)) return undefined;
  const start = after > moscowDateTime(now).date ? after : moscowDateTime(now).date;
  for (let offset = 0; offset <= 7; offset++) {
    const slot = slotsForTourDay(addTourDays(start, offset), events, now)[0];
    if (slot) return slot;
  }
  return undefined;
}

export function bookingFromSlot(slot: TourSlot): TourBooking {
  return { date: slot.date, time: slot.time, projects: [...slot.projects] };
}

export function defaultTourBooking(events: TourEvent[], now = new Date()): TourBooking {
  const date = tomorrowInMoscow(now);
  const slot = slotsForTourDay(date, events, now)[0];
  return slot ? bookingFromSlot(slot) : { date, time: '', projects: [] };
}

export function bookingForTourDate(date: string, current: TourBooking, events: TourEvent[], now = new Date()): TourBooking {
  const slots = slotsForTourDay(date, events, now);
  const route = projectsKey(current.projects);
  const matching = slots.filter(slot => projectsKey(slot.projects) === route);
  const chosen = matching.find(slot => slot.time === current.time) || matching[0] || slots[0];
  return chosen ? bookingFromSlot(chosen) : { date, time: '', projects: [...current.projects] };
}

export function projectsKey(projects: string[]): string {
  return [...projects].sort().join('|');
}

export function isAvailableTourBooking(booking: TourBooking, events: TourEvent[], now = new Date()): boolean {
  return slotsForTourDay(booking.date, events, now).some(slot => slot.time === booking.time
    && projectsKey(slot.projects) === projectsKey(booking.projects));
}

/** Backwards-compatible text consumed by the existing source=broker-tour API. */
export function tourBookingMessage(booking: TourBooking, comment = ''): string {
  const [year, month, day] = booking.date.split('-');
  const message = `Брокер-тур ${day}.${month}.${year} в ${booking.time} — ${booking.projects.join(', ')}`;
  return comment.trim() ? `${message}\nКомментарий: ${comment.trim()}` : message;
}
