import assert from 'node:assert/strict';
import test from 'node:test';
import { allTourSlots, bookingForTourDate, bookingFromSlot, defaultTourBooking, isAvailableTourBooking, isCalendarDate, moscowDateTime, nextTourSlot, slotsForTourDay, tomorrowInMoscow, tourBookingMessage, tourMonthGrid, tourWorkWeek, type TourEvent } from './broker-tour-booking';

const combined: TourEvent = { date: '2026-10-09T15:00:00+03:00', title: 'Брокер-тур: Зорге 9 + Серебряный Бор' };
test('Moscow tomorrow is timezone-independent through month/year ends and DST dates', () => {
  for (const [instant, expected] of [
    ['2026-10-02T21:30:00Z', '2026-10-04'],
    ['2026-10-31T20:59:00Z', '2026-11-01'],
    ['2026-12-31T20:59:00Z', '2027-01-01'],
    ['2026-12-31T21:00:00Z', '2027-01-02'],
    ['2026-03-29T00:30:00Z', '2026-03-30'],
    ['2026-10-25T00:30:00Z', '2026-10-26'],
  ]) assert.equal(tomorrowInMoscow(new Date(instant)), expected);
});
test('Moscow calendar week and month use UTC-only date arithmetic', () => {
  assert.deepEqual(tourWorkWeek(0, new Date('2026-10-02T21:30:00Z')), ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  assert.equal(tourWorkWeek(1, new Date('2026-12-31T21:30:00Z'))[0], '2027-01-04');
  const grid = tourMonthGrid(2026, 11);
  assert.equal(grid.filter(Boolean).length, 31);
  assert.equal(tourMonthGrid(2026, 12).filter(Boolean)[0], '2027-01-01');
});
test('API offset and UTC timestamps display the actual Moscow date and time', () => {
  assert.deepEqual(moscowDateTime(new Date('2026-10-08T23:30:00Z')), { date: '2026-10-09', time: '02:30' });
  assert.equal(allTourSlots([combined])[0].date, '2026-10-09');
  assert.equal(allTourSlots([combined])[0].time, '15:00');
  assert.equal(allTourSlots([{ ...combined, date: '2026-10-09T15:00:00' }])[0].startsAt, new Date(combined.date).getTime());
});
test('combined tours preserve both projects and deduplicate same-instant CMS events', () => {
  const slots = allTourSlots([combined, { ...combined, title: 'Брокер-тур: Зорге 9' }]);
  assert.equal(slots.length, 1);
  assert.deepEqual(bookingFromSlot(slots[0]).projects, ['Зорге 9', 'Квартал Серебряный Бор']);
});
test('same Moscow minute with different CMS seconds cannot create duplicate option keys', () => {
  const slots = allTourSlots([combined, { ...combined, date: '2026-10-09T15:00:30+03:00', title: 'Брокер-тур: Зорге 9' }]);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].time, '15:00');
  assert.deepEqual(slots[0].projects, ['Зорге 9', 'Квартал Серебряный Бор']);
});
test('elapsed slots are excluded, exact now included, inactive and invalid events excluded', () => {
  const now = new Date('2026-10-09T15:00:00+03:00');
  assert.equal(slotsForTourDay('2026-10-09', [combined], now).length, 1);
  assert.equal(slotsForTourDay('2026-10-09', [combined], new Date(now.getTime() + 1)).length, 0);
  assert.equal(slotsForTourDay('2026-10-09', [combined], new Date(now.getTime() + 1), true).length, 1);
  assert.equal(allTourSlots([{ ...combined, isActive: false }, { ...combined, date: 'bad' }]).length, 0);
});
test('weekend tomorrow remains selected and empty; next available date is explicit', () => {
  const now = new Date('2026-10-02T09:00:00Z');
  assert.deepEqual(defaultTourBooking([combined], now), { date: '2026-10-03', time: '', projects: [] });
  assert.deepEqual(slotsForTourDay('2026-10-03', [], now), []);
  assert.equal(nextTourSlot([combined], '2026-10-03', now)?.date, '2026-10-05');
});
test('approved regular weekday schedule is retained, dated CMS times override it', () => {
  const now = new Date('2026-10-02T09:00:00Z');
  assert.deepEqual(slotsForTourDay('2026-10-05', [], now).map(s => s.time), ['11:00', '15:00']);
  assert.deepEqual(slotsForTourDay('2026-10-09', [combined], now).map(s => s.time), ['15:00']);
  assert.equal(slotsForTourDay('2026-10-09', [combined], new Date('2026-10-09T13:00:00Z')).length, 0, 'Elapsed CMS override must not revive recurrence');
});
test('available selection requires exact actual project itinerary and future time', () => {
  const now = new Date('2026-10-09T09:00:00Z');
  const booking = bookingFromSlot(allTourSlots([combined])[0]);
  assert.ok(isAvailableTourBooking(booking, [combined], now));
  assert.equal(isAvailableTourBooking({ ...booking, projects: ['Зорге 9'] }, [combined], now), false);
  assert.equal(isAvailableTourBooking(booking, [combined], new Date('2026-10-09T13:00:00Z')), false);
});
test('editing date retains selected route and time when available, then first matching time', () => {
  const now = new Date('2026-10-02T09:00:00Z');
  const booking = bookingFromSlot(allTourSlots([combined])[0]);
  assert.deepEqual(bookingForTourDate('2026-10-06', booking, [], now), { ...booking, date: '2026-10-06' });
  const override = { ...combined, date: '2026-10-06T16:30:00+03:00' };
  assert.equal(bookingForTourDate('2026-10-06', booking, [override], now).time, '16:30');
  assert.deepEqual(bookingForTourDate('2026-10-03', booking, [], now), { ...booking, date: '2026-10-03', time: '' });
});
test('structured selection serializes to the existing amo note contract', () => {
  assert.equal(tourBookingMessage(bookingFromSlot(allTourSlots([combined])[0]), ' Встреча у входа '), 'Брокер-тур 09.10.2026 в 15:00 — Зорге 9, Квартал Серебряный Бор\nКомментарий: Встреча у входа');
});
test('date input rejects overflowed calendar dates', () => {
  assert.equal(isCalendarDate('2026-02-30'), false);
  assert.equal(isCalendarDate('2028-02-29'), true);
  assert.equal(isCalendarDate(''), false);
});
