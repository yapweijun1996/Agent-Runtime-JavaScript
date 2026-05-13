const TIMEZONE_ALIASES = new Map([
  ["singapore", "Asia/Singapore"],
  ["新加坡", "Asia/Singapore"],
  ["tokyo", "Asia/Tokyo"],
  ["东京", "Asia/Tokyo"],
  ["shanghai", "Asia/Shanghai"],
  ["上海", "Asia/Shanghai"],
  ["beijing", "Asia/Shanghai"],
  ["北京", "Asia/Shanghai"],
  ["hong kong", "Asia/Hong_Kong"],
  ["hongkong", "Asia/Hong_Kong"],
  ["香港", "Asia/Hong_Kong"],
  ["taipei", "Asia/Taipei"],
  ["台北", "Asia/Taipei"],
  ["london", "Europe/London"],
  ["伦敦", "Europe/London"],
  ["paris", "Europe/Paris"],
  ["巴黎", "Europe/Paris"],
  ["berlin", "Europe/Berlin"],
  ["柏林", "Europe/Berlin"],
  ["new york", "America/New_York"],
  ["纽约", "America/New_York"],
  ["los angeles", "America/Los_Angeles"],
  ["洛杉矶", "America/Los_Angeles"],
  ["chicago", "America/Chicago"],
  ["芝加哥", "America/Chicago"],
  ["sydney", "Australia/Sydney"],
  ["悉尼", "Australia/Sydney"],
  ["melbourne", "Australia/Melbourne"],
  ["墨尔本", "Australia/Melbourne"]
]);
const IANA_TIMEZONE_PATTERN = /\b([A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\b/;

export const toolSummaries = [
  {
    description: "Return the current time for the local browser timezone or a requested timezone.",
    name: "worldtime_now",
    parameters: {
      properties: {
        timezone: {
          description: "An IANA timezone like Asia/Tokyo, or a common city alias like Tokyo or Singapore.",
          type: "string"
        }
      },
      required: [],
      type: "object"
    },
    riskTier: 0
  }
];

export default [
  {
    ...toolSummaries[0],
    async func(args = {}) {
      const requestedTimeZone = resolveRequestedTimeZone(args.timezone);
      const now = new Date();
      const timeZone = requestedTimeZone || readLocalTimeZone();
      const result = buildTimeResult(now, timeZone);

      return {
        ...result,
        ok: true,
        requestedTimeZone: requestedTimeZone || null
      };
    }
  }
];

function resolveRequestedTimeZone(value) {
  const explicit = readString(value);
  if (!explicit) {
    return null;
  }

  const directIana = extractExplicitTimeZone(explicit);
  if (directIana) {
    return directIana;
  }

  const alias = TIMEZONE_ALIASES.get(normalizeQuery(explicit));
  return alias || null;
}

function extractExplicitTimeZone(query) {
  const match = query.match(IANA_TIMEZONE_PATTERN);

  if (!match) {
    return null;
  }

  return isValidTimeZone(match[1]) ? match[1] : null;
}

function normalizeQuery(query) {
  return readString(query)
    .toLowerCase()
    .replace(/[?.!,]/g, " ")
    .replace(/\s+/g, " ");
}

function readLocalTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local";
  } catch {
    return "Local";
  }
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function buildTimeResult(now, timeZone) {
  const currentTime = formatCurrentTime(now, timeZone);
  const dayOfWeek = formatDayOfWeek(now, timeZone);
  const timezone = isValidTimeZone(timeZone) ? timeZone : "Local";
  const utcOffset = readUtcOffset(now, timezone);
  const text = `Current time in ${timezone}: ${currentTime} (${utcOffset}, ${dayOfWeek})`;

  return {
    currentTime,
    current_time: currentTime,
    dayOfWeek,
    day_of_week: dayOfWeek,
    iso: now.toISOString(),
    source: "Intl.DateTimeFormat",
    text,
    timezone,
    utcOffset,
    utc_offset: utcOffset
  };
}

function formatCurrentTime(now, timeZone) {
  const formatOptions = {
    day: "numeric",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "long",
    second: "2-digit",
    weekday: "long",
    year: "numeric"
  };

  if (!isValidTimeZone(timeZone)) {
    return now.toLocaleString();
  }

  return new Intl.DateTimeFormat(undefined, {
    ...formatOptions,
    timeZone
  }).format(now);
}

function formatDayOfWeek(now, timeZone) {
  if (!isValidTimeZone(timeZone)) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long"
    }).format(now);
  }

  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: "long"
  }).format(now);
}

function readUtcOffset(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZone: isValidTimeZone(timeZone) ? timeZone : undefined,
      timeZoneName: "longOffset"
    }).formatToParts(now);
    const offsetPart = parts.find((part) => part.type === "timeZoneName");
    return offsetPart ? offsetPart.value.replace("GMT", "UTC") : "UTC";
  } catch {
    return "UTC";
  }
}

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}
