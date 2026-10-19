function dayBoundary(day, endOfDay) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error('Invalid attendance date range.');
  }
  const timestamp = Date.parse(`${day}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+03:00`);
  if (!Number.isFinite(timestamp) || new Date(timestamp + 3 * 60 * 60 * 1000).toISOString().slice(0, 10) !== day) {
    throw new Error('Invalid attendance date range.');
  }
  return timestamp;
}

export function filterAttendanceToRange(records, from, to) {
  const start = from ? dayBoundary(from, false) : Number.NEGATIVE_INFINITY;
  const end = to ? dayBoundary(to, true) : Number.POSITIVE_INFINITY;
  if (start > end) throw new Error('Attendance start date must not follow the end date.');
  if (!from && !to) return records;

  return records.filter((record) => {
    const timestamp = typeof record?.record_time === 'string' ? Date.parse(record.record_time) : Number.NaN;
    return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
  });
}
