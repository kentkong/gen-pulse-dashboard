/**
 * Tiny scheduler: fire a callback every Monday at a given local time in a given
 * IANA timezone. Zero dependencies — just setTimeout and Intl.
 *
 * Good enough for one-per-week jobs. For high-frequency cron we'd bring in
 * node-cron, but the Monday report doesn't justify a new dep.
 */

const MS_PER_MIN = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MIN;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function nowPartsInTz(timezone, at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const weekdayOrder = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    weekday: weekdayOrder[get("weekday")] ?? 0, // 1=Mon..7=Sun
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
  };
}

/** Milliseconds from `now` until the next `targetWeekday` (1..7) at HH:MM in `timezone`. */
export function msUntilNextWeekly({
  timezone = "Europe/Prague",
  weekday = 1, // 1 = Monday
  hour = 8,
  minute = 0,
  now = new Date(),
}) {
  const cur = nowPartsInTz(timezone, now);
  let daysAhead = (weekday - cur.weekday + 7) % 7;
  // If today *is* the target weekday but the time has already passed, roll to next week.
  if (
    daysAhead === 0 &&
    (cur.hour > hour || (cur.hour === hour && cur.minute >= minute))
  ) {
    daysAhead = 7;
  }
  const msToTarget =
    daysAhead * MS_PER_DAY +
    (hour - cur.hour) * MS_PER_HOUR +
    (minute - cur.minute) * MS_PER_MIN -
    cur.second * 1000;
  // Clamp to at least 1s so setTimeout never runs immediately if clocks jitter.
  return Math.max(1_000, msToTarget);
}

/**
 * Schedule `fn` to run every week at `weekday` HH:MM in `timezone`.
 * Returns a cancel() function.
 */
export function scheduleWeekly({
  timezone = "Europe/Prague",
  weekday = 1,
  hour = 8,
  minute = 0,
  fn,
  onError,
  label = "weekly",
}) {
  if (typeof fn !== "function") throw new Error("scheduleWeekly: fn required");
  let cancelled = false;
  let timer = null;

  const armNext = () => {
    if (cancelled) return;
    const wait = msUntilNextWeekly({ timezone, weekday, hour, minute });
    const fireAt = new Date(Date.now() + wait);
    // eslint-disable-next-line no-console
    console.log(
      `[schedule] ${label}: next run at ${fireAt.toISOString()} (in ${Math.round(
        wait / 1000
      )}s, tz ${timezone})`
    );
    timer = setTimeout(async () => {
      try {
        await fn();
      } catch (err) {
        if (onError) onError(err);
        else {
          // eslint-disable-next-line no-console
          console.error(`[schedule] ${label} failed:`, err);
        }
      } finally {
        armNext();
      }
    }, wait);
  };

  armNext();

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
