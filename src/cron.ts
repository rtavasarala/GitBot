interface CronField {
  values: Set<number>;
  wildcard: boolean;
}

export interface CronSchedule {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseField(field: string, min: number, max: number, name: string, sunday = false): CronField {
  if (!field) throw new Error(`Invalid ${name} field`);
  const values = new Set<number>();
  const parts = field.split(",");

  for (const part of parts) {
    if (!part) throw new Error(`Invalid ${name} field`);
    const slashParts = part.split("/");
    if (slashParts.length > 2) throw new Error(`Invalid ${name} field`);
    const base = slashParts[0];
    let step = 1;
    if (slashParts.length === 2) {
      if (!/^\d+$/.test(slashParts[1])) throw new Error(`Invalid ${name} step`);
      step = Number(slashParts[1]);
      if (!Number.isSafeInteger(step) || step < 1) throw new Error(`Invalid ${name} step`);
    }

    let start: number;
    let end: number;
    if (base === "*") {
      start = min;
      end = max;
    } else if (/^\d+-\d+$/.test(base)) {
      const [startText, endText] = base.split("-");
      start = Number(startText);
      end = Number(endText);
      if (start < min || start > max || end < min || end > max || start > end) {
        throw new Error(`Out-of-range ${name} range`);
      }
    } else if (/^\d+$/.test(base)) {
      if (slashParts.length === 2) throw new Error(`Invalid ${name} step`);
      start = Number(base);
      end = start;
      if (start < min || start > max) throw new Error(`Out-of-range ${name} value`);
    } else {
      throw new Error(`Invalid ${name} field`);
    }

    for (let value = start; value <= end; value += step) {
      values.add(sunday && value === 7 ? 0 : value);
    }
  }

  return { values, wildcard: field === "*" };
}

export function parseCron(expr: string): CronSchedule {
  if (typeof expr !== "string") throw new Error("Cron expression must be a string");
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some(field => !field)) {
    throw new Error("Cron expression must contain five fields");
  }
  return {
    minute: parseField(fields[0], 0, 59, "minute"),
    hour: parseField(fields[1], 0, 23, "hour"),
    dayOfMonth: parseField(fields[2], 1, 31, "day-of-month"),
    month: parseField(fields[3], 1, 12, "month"),
    dayOfWeek: parseField(fields[4], 0, 7, "day-of-week", true),
  };
}

function matchesDay(schedule: CronSchedule, dayOfMonth: number, dayOfWeek: number): boolean {
  const domMatches = schedule.dayOfMonth.values.has(dayOfMonth);
  const dowMatches = schedule.dayOfWeek.values.has(dayOfWeek);
  if (!schedule.dayOfMonth.wildcard && !schedule.dayOfWeek.wildcard) {
    return domMatches || dowMatches;
  }
  if (schedule.dayOfMonth.wildcard) return dowMatches;
  if (schedule.dayOfWeek.wildcard) return domMatches;
  return true;
}

export function nextCronTime(expr: string, after: Date): Date {
  const schedule = parseCron(expr);
  if (!Number.isFinite(after.getTime())) throw new Error("Invalid date");
  const afterMinute = Math.floor(after.getTime() / 60_000) * 60_000;
  const firstDay = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  const hours = [...schedule.hour.values].sort((a, b) => a - b);
  const minutes = [...schedule.minute.values].sort((a, b) => a - b);

  for (let dayOffset = 0; dayOffset < 8 * 366; dayOffset++) {
    const day = new Date(firstDay);
    day.setDate(firstDay.getDate() + dayOffset);
    const year = day.getFullYear();
    const month = day.getMonth();
    const dayOfMonth = day.getDate();
    if (!schedule.month.values.has(month + 1)
      || !matchesDay(schedule, dayOfMonth, day.getDay())) {
      continue;
    }

    for (const hour of hours) {
      for (const minute of minutes) {
        const candidate = new Date(year, month, dayOfMonth, hour, minute);
        if (candidate.getHours() !== hour || candidate.getMinutes() !== minute) continue;
        if (candidate.getTime() > afterMinute) return candidate;
      }
    }
  }

  throw new Error("No matching cron time within 8 years");
}
