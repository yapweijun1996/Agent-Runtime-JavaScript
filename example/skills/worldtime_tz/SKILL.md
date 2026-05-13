---
name: worldtime_tz
description: Get the current local time or a requested timezone using a bundled browser-safe tool.
---
# World Time TZ

Use this skill when the user asks for the current time, current date, timezone offset, or local time in a city or IANA timezone.

Rules:

1. Use the `worldtime_now` tool to get the actual time result. Do not invent or estimate the current time.
2. If the user names a city like Tokyo or Singapore, pass it as the `timezone` argument when possible.
3. If the user does not specify a timezone, use the tool default and treat the local browser timezone as acceptable.
4. You may call this tool directly. Only list, read, or activate the skill first when the user explicitly asks about skills or the skill instructions must remain active across later steps.
5. After the tool returns, finalize the answer for the user instead of repeating the same tool call.
