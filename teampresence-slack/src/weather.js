/**
 * Weather provider — Open-Meteo forecast client for the hero chip.
 *
 * Open-Meteo (https://open-meteo.com/) is free, key-less, and has a
 * generous enough rate limit that a 10-minute server-side cache is
 * more than sufficient for a dashboard the size of Gen Pulse.
 *
 * DESIGN
 *   - Server-side fetch keeps API keys / cache policy / error
 *     handling off the client.
 *   - In-memory cache (10 min TTL) per server process — good enough
 *     for one or two horizontal instances. Swap for Redis later if
 *     we ever run at scale.
 *   - Fails "soft": if Open-Meteo is unreachable we return the last
 *     known-good reading (even if stale), so the chip keeps showing
 *     something sensible instead of flickering to "weather
 *     unavailable" during a transient network hiccup.
 *   - WMO weather-code → { label, icon } mapping is done here so
 *     the client only has to pick an SVG by icon id.
 *
 * ENV
 *   WEATHER_LAT      — latitude, decimal degrees (e.g. 50.0755)
 *   WEATHER_LON      — longitude, decimal degrees (e.g. 14.4378)
 *   WEATHER_LABEL    — display label (e.g. "Prague"). Optional;
 *                      falls back to "lat,lon" rounded to 2dp.
 *   WEATHER_UNITS    — "metric" (default) or "imperial". Controls
 *                      which temp is primary in the response.
 *
 * The provider is *disabled* if WEATHER_LAT or WEATHER_LON is unset.
 * Callers should treat a null return from getCurrent() as "widget
 * off, don't render".
 */

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const FETCH_TIMEOUT_MS = 4000; // don't hang the route on a flaky network

// WMO weather interpretation codes.
// https://open-meteo.com/en/docs (see weathercode table)
// We collapse them into a small icon set so the frontend stays lean.
const WEATHER_CODES = {
  0:  { icon: "sun",     label: "Clear" },
  1:  { icon: "sun-cloud", label: "Mostly clear" },
  2:  { icon: "sun-cloud", label: "Partly cloudy" },
  3:  { icon: "cloud",   label: "Overcast" },
  45: { icon: "fog",     label: "Fog" },
  48: { icon: "fog",     label: "Rime fog" },
  51: { icon: "drizzle", label: "Light drizzle" },
  53: { icon: "drizzle", label: "Drizzle" },
  55: { icon: "drizzle", label: "Heavy drizzle" },
  56: { icon: "drizzle", label: "Freezing drizzle" },
  57: { icon: "drizzle", label: "Freezing drizzle" },
  61: { icon: "rain",    label: "Light rain" },
  63: { icon: "rain",    label: "Rain" },
  65: { icon: "rain",    label: "Heavy rain" },
  66: { icon: "rain",    label: "Freezing rain" },
  67: { icon: "rain",    label: "Freezing rain" },
  71: { icon: "snow",    label: "Light snow" },
  73: { icon: "snow",    label: "Snow" },
  75: { icon: "snow",    label: "Heavy snow" },
  77: { icon: "snow",    label: "Snow grains" },
  80: { icon: "shower",  label: "Rain showers" },
  81: { icon: "shower",  label: "Rain showers" },
  82: { icon: "shower",  label: "Heavy showers" },
  85: { icon: "snow",    label: "Snow showers" },
  86: { icon: "snow",    label: "Heavy snow showers" },
  95: { icon: "thunder", label: "Thunderstorm" },
  96: { icon: "thunder", label: "Thunderstorm + hail" },
  99: { icon: "thunder", label: "Severe thunderstorm" },
};

function interpretCode(code) {
  return WEATHER_CODES[code] ?? { icon: "cloud", label: "Unknown" };
}

function cToF(c) {
  if (typeof c !== "number" || Number.isNaN(c)) return null;
  return Math.round((c * 9) / 5 + 32);
}

function round1(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return null;
  return Math.round(n * 10) / 10;
}

/**
 * Build a weather service from env vars. Returns null if the
 * provider is disabled (no lat/lon).
 */
export function weatherServiceFromEnv(env = process.env, logger = console) {
  const lat = Number.parseFloat(env.WEATHER_LAT ?? "");
  const lon = Number.parseFloat(env.WEATHER_LON ?? "");
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null; // disabled
  }
  const label =
    (env.WEATHER_LABEL ?? "").trim() ||
    `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const units = (env.WEATHER_UNITS ?? "metric").toLowerCase() === "imperial"
    ? "imperial"
    : "metric";
  return createWeatherService({ lat, lon, label, units, logger });
}

export function createWeatherService({
  lat,
  lon,
  label,
  units = "metric",
  logger = console,
  fetchImpl = null,
  now = () => Date.now(),
} = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (!doFetch) {
    throw new Error("weather: global fetch unavailable (Node < 18?)");
  }
  let cache = null; // { ts, data }
  let lastGood = null; // soft-fail fallback

  async function fetchFresh() {
    const url = new URL(OPEN_METEO_BASE);
    url.searchParams.set("latitude", String(lat));
    url.searchParams.set("longitude", String(lon));
    url.searchParams.set("current", "temperature_2m,weather_code,is_day,wind_speed_10m");
    url.searchParams.set("timezone", "auto");

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(url.toString(), { signal: ctl.signal });
      if (!res.ok) {
        throw new Error(`open-meteo HTTP ${res.status}`);
      }
      const body = await res.json();
      const cur = body?.current ?? {};
      const tempC = round1(cur.temperature_2m);
      const code = Number.isFinite(cur.weather_code) ? cur.weather_code : null;
      const { icon, label: condLabel } = interpretCode(code);
      const isDay = cur.is_day === 1 || cur.is_day === true;
      const reading = {
        location: label,
        tempC,
        tempF: cToF(tempC),
        units,
        conditionCode: code,
        condition: condLabel,
        icon: !isDay && icon === "sun" ? "moon" : icon,
        isDay,
        windKmh: round1(cur.wind_speed_10m),
        observedAt: cur.time ?? null,
        fetchedAt: new Date(now()).toISOString(),
        stale: false,
      };
      lastGood = reading;
      return reading;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getCurrent() {
    const t = now();
    if (cache && t - cache.ts < CACHE_TTL_MS) {
      return cache.data;
    }
    try {
      const fresh = await fetchFresh();
      cache = { ts: t, data: fresh };
      return fresh;
    } catch (err) {
      logger.warn?.("[weather] fetch failed:", err?.message ?? err);
      if (lastGood) {
        // Serve the last-known-good reading but flag it as stale so
        // the UI can badge it (or downgrade tastefully).
        return { ...lastGood, stale: true };
      }
      return null;
    }
  }

  return {
    kind: "open-meteo",
    location: label,
    getCurrent,
  };
}

// Exposed for tests / extending: lets callers render an icon
// consistently without re-importing the table.
export { interpretCode as interpretWeatherCode };
