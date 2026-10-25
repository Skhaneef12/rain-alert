"""Rain alerts for home via Telegram.

Default: hourly warning. --daily: morning summary. --tomorrow: evening preview of tomorrow.
Commands, buttons and access requests are answered instantly by the Cloudflare Worker in
../worker; this script only reads the settings it saves in each chat's pinned status message.
"""
import argparse
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from typing import NamedTuple, Optional

import requests

# Rain thresholds. Override with the RAIN_MM_THRESHOLD / RAIN_PROB_THRESHOLD environment
# variables (set as GitHub repository variables) without changing the code.
RAIN_MM_THRESHOLD = float(os.environ.get("RAIN_MM_THRESHOLD") or 0.2)   # mm in a 15-minute slot
RAIN_PROB_THRESHOLD = int(os.environ.get("RAIN_PROB_THRESHOLD") or 40)  # % hourly probability

# Rounded to ~1 km on purpose: Open-Meteo uses the same forecast grid point as for the exact
# address, so forecasts are identical, but the code doesn't reveal where the house is.
LATITUDE = -34.91
LONGITUDE = -56.15
TIMEZONE = "America/Montevideo"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
SLOT = timedelta(minutes=15)
LOOKAHEAD = timedelta(hours=3)

# Pinned status message, shared with worker/src/index.js (keep both formats identical):
#   📌 Rain alert status: ON 🔔
#   👕 Warnings muted for today (2026-10-23)     (optional)
#   👤 Ana – 123456789                            (owner's chat only: approved users)
#   ⏳ Bruno – 987654321                          (owner's chat only: waiting for approval)
#   Commands: /now /on /off /status
STATUS_PREFIX = "📌 Rain alert status:"
MUTE_RE = re.compile(r"Warnings muted for today \((\d{4}-\d{2}-\d{2})\)")
APPROVED_RE = re.compile(r"^👤 (.+) – (-?\d+)$")
PENDING_RE = re.compile(r"^⏳ (.+) – (-?\d+)$")
WARNING_BUTTONS = {"inline_keyboard": [[
    {"text": "👕 Clothes are in", "callback_data": "clothes_in"},
    {"text": "🔕 Warnings off", "callback_data": "off"},
]]}


class Slot(NamedTuple):
    start: datetime  # naive Montevideo local time
    mm: float
    prob: int


class ChatState:
    """What the bot remembers per chat, stored in a message pinned in that chat."""

    def __init__(self, on=True, muted: Optional[date] = None, msg_id: Optional[int] = None,
                 approved: Optional[list] = None, pending: Optional[list] = None):
        self.on, self.muted, self.msg_id = on, muted, msg_id
        # (name, chat id) pairs; only the owner's status message has these. Kept as-is.
        self.approved: list[tuple[str, str]] = approved or []
        self.pending: list[tuple[str, str]] = pending or []
        self.changed = False

    def is_muted(self, today: date) -> bool:
        return self.muted == today

    def text(self) -> str:
        lines = [f"{STATUS_PREFIX} {'ON 🔔' if self.on else 'OFF 🔕'}"]
        if self.muted:
            lines.append(f"👕 Warnings muted for today ({self.muted.isoformat()})")
        lines += [f"👤 {name} – {cid}" for name, cid in self.approved]
        lines += [f"⏳ {name} – {cid}" for name, cid in self.pending]
        lines.append("Commands: /now /on /off /status")
        return "\n".join(lines)


class TelegramError(Exception):
    def __init__(self, method: str, status: int = 0):
        super().__init__(method)
        self.status = status


# ---------------------------------------------------------------- forecast

def fetch_forecast() -> dict:
    params = {
        "latitude": LATITUDE,
        "longitude": LONGITUDE,
        "minutely_15": "precipitation",
        "hourly": "precipitation_probability",
        "timezone": TIMEZONE,
        "forecast_days": 3,
    }
    for attempt in range(2):
        try:
            resp = requests.get(FORECAST_URL, params=params, timeout=20)
            if resp.status_code == 200:
                return resp.json()
            print(f"Open-Meteo returned HTTP {resp.status_code}", file=sys.stderr)
        except (requests.RequestException, ValueError) as exc:
            print(f"Open-Meteo request failed: {type(exc).__name__}", file=sys.stderr)
        if attempt == 0:
            time.sleep(5)
    print("Forecast unavailable after retry; not sending anything.", file=sys.stderr)
    sys.exit(1)


def build_slots(data: dict) -> tuple[datetime, list[Slot]]:
    """Return (now, slots) for slots ending after one hour ago.

    Open-Meteo values describe the *preceding* interval: a 15-minute value at T covers
    [T-15min, T), an hourly value at H covers [H-1h, H).
    Slots with a missing value are left out; require_coverage() catches the gap.
    """
    offset = timedelta(seconds=data["utc_offset_seconds"])
    now = datetime.now(timezone.utc).replace(tzinfo=None) + offset

    hourly = data["hourly"]
    prob_by_hour = {
        datetime.fromisoformat(t): p
        for t, p in zip(hourly["time"], hourly["precipitation_probability"])
    }

    slots = []
    m15 = data["minutely_15"]
    for t, mm in zip(m15["time"], m15["precipitation"]):
        end = datetime.fromisoformat(t)
        start = end - SLOT
        if end <= now - timedelta(hours=1):
            continue
        prob = prob_by_hour.get(start.replace(minute=0) + timedelta(hours=1))
        if mm is None or prob is None:
            continue
        slots.append(Slot(start, mm, prob))
    return now, slots


def require_coverage(now: datetime, slots: list[Slot], until: datetime) -> None:
    """Exit non-zero unless every 15-minute slot from now until `until` has data.

    A gap in the forecast must never be reported as "no rain".
    """
    have = {s.start for s in slots}
    t = now.replace(minute=now.minute // 15 * 15, second=0, microsecond=0)
    while t < until:
        if t not in have:
            print(f"Forecast is missing data for {t:%Y-%m-%d %H:%M}; not sending anything.",
                  file=sys.stderr)
            sys.exit(1)
        t += SLOT


# ---------------------------------------------------------------- messages

def is_rain(mm: float, prob: int) -> bool:
    return mm >= RAIN_MM_THRESHOLD or prob >= RAIN_PROB_THRESHOLD


def upcoming(now: datetime, slots: list[Slot]) -> list[Slot]:
    """Slots from the one in progress now until LOOKAHEAD ahead."""
    return [s for s in slots if s.start + SLOT > now and s.start < now + LOOKAHEAD]


def hourly_message(now: datetime, slots: list[Slot]) -> Optional[str]:
    future = [s for s in slots if s.start + SLOT > now]
    for i, s in enumerate(future):
        if s.start >= now + LOOKAHEAD:
            break
        if not is_rain(s.mm, s.prob):
            continue
        minutes = max(0, (s.start - now).total_seconds() / 60)
        if minutes < 30:
            label = "RAINING NOW"
        elif minutes < 90:
            label = "RAIN IN ~1 HOUR"
        elif minutes < 150:
            label = "RAIN IN ~2 HOURS"
        else:
            return None
        hour_mm = sum(x.mm for x in future[i:i + 4])  # expected mm in the hour from then
        at = max(s.start, now)
        return (f"☔ {label} – Bring in the clothes. Rain around {at:%H:%M}, "
                f"{s.prob}% chance, {hour_mm:.1f} mm.")
    return None


def dry_again_message(now: datetime, slots: list[Slot]) -> Optional[str]:
    """Rain in the past hour, none in the next 3 hours. Fires on one run per rain spell."""
    past = [s for s in slots if s.start + SLOT <= now]
    if not any(is_rain(s.mm, s.prob) for s in past):
        return None
    if any(is_rain(s.mm, s.prob) for s in upcoming(now, slots)):
        return None
    return "🌤 DRY AGAIN – The rain has stopped and none is expected for 3 hours. OK to hang the clothes out."


def day_summary(slots: list[Slot], start: datetime, end: datetime, title: str, no_rain: str) -> str:
    """Rain windows between start and end, e.g. the rest of today or all of tomorrow."""
    day = [s for s in slots if s.start + SLOT > start and s.start < end]

    # Collapse 15-minute slots into hours: an hour is rainy if any of its slots is.
    hours: dict[datetime, tuple[bool, int]] = {}
    for s in day:
        h = s.start.replace(minute=0)
        rain, peak = hours.get(h, (False, 0))
        hours[h] = (rain or is_rain(s.mm, s.prob), max(peak, s.prob))

    windows: list[list] = []  # [start, end, peak]
    for h in sorted(hours):
        rain, prob = hours[h]
        if not rain:
            continue
        if windows and windows[-1][1] == h:
            windows[-1][1] = h + timedelta(hours=1)
            windows[-1][2] = max(windows[-1][2], prob)
        else:
            windows.append([h, h + timedelta(hours=1), prob])

    if not windows:
        return no_rain

    total = sum(s.mm for s in day)
    first_rain = windows[0][0]
    if first_rain <= start:
        advice = "No rain-free window before the first rain – keep the clothes inside."
    else:
        advice = f"Hang the clothes before {first_rain:%H:%M}."

    parts = [f"{w[0]:%H:%M}-{'23:59' if w[1] >= end else f'{w[1]:%H:%M}'} (peak {w[2]}%)"
             for w in windows]
    shown = len(parts)
    while True:
        listed = ", ".join(parts[:shown])
        if shown < len(parts):
            listed += f" +{len(parts) - shown} more"
        msg = f"{title} {listed}. Total ~{total:.1f} mm. {advice}"
        if len(msg) < 400 or shown == 1:
            return msg
        shown -= 1


def daily_message(now: datetime, slots: list[Slot]) -> str:
    midnight = datetime.combine(now.date() + timedelta(days=1), datetime.min.time())
    return day_summary(slots, now, midnight, "🌦 Today's rain forecast:",
                       "☀️ No rain expected today. Good day to dry clothes outside.")


def tomorrow_message(now: datetime, slots: list[Slot]) -> str:
    start = datetime.combine(now.date() + timedelta(days=1), datetime.min.time())
    return day_summary(slots, start, start + timedelta(days=1), "🌙 Tomorrow's rain forecast:",
                       "🌙 No rain expected tomorrow. Good day to dry clothes outside.")


# ---------------------------------------------------------------- telegram

def tg(method: str, **payload):
    """Call the Telegram Bot API, retrying network errors, 5xx and 429 (up to 3 attempts)."""
    url = f"https://api.telegram.org/bot{os.environ['TELEGRAM_BOT_TOKEN']}/{method}"
    status = 0
    for attempt in range(3):
        wait = 5
        try:
            resp = requests.post(url, json=payload, timeout=20)
        except requests.RequestException as exc:
            # Do not print exc itself: its message contains the URL, which holds the token.
            print(f"Telegram {method} failed: {type(exc).__name__}", file=sys.stderr)
        else:
            if resp.status_code == 200:
                return resp.json()["result"]
            status = resp.status_code
            try:
                body = resp.json()
            except ValueError:
                body = {}
            print(f"Telegram {method} returned HTTP {resp.status_code}: "
                  f"{body.get('description', '')}", file=sys.stderr)
            if resp.status_code == 429:
                wait = body.get("parameters", {}).get("retry_after", 5)
            elif resp.status_code < 500:
                break
        if attempt < 2:
            time.sleep(wait)
    raise TelegramError(method, status)


def load_state(chat_id: str, today: date) -> ChatState:
    pinned = tg("getChat", chat_id=chat_id).get("pinned_message") or {}
    text = pinned.get("text", "")
    if not (pinned.get("from", {}).get("is_bot") and text.startswith(STATUS_PREFIX)):
        return ChatState()
    lines = text.splitlines()
    mute = MUTE_RE.search(text)
    state = ChatState(on="OFF" not in lines[0],
                      muted=date.fromisoformat(mute.group(1)) if mute else None,
                      msg_id=pinned["message_id"],
                      approved=[m.groups() for m in map(APPROVED_RE.match, lines) if m],
                      pending=[m.groups() for m in map(PENDING_RE.match, lines) if m])
    if state.muted and state.muted < today:  # yesterday's mute has expired
        state.muted, state.changed = None, True
    return state


def save_state(chat_id: str, state: ChatState) -> None:
    if state.msg_id:
        try:
            tg("editMessageText", chat_id=chat_id, message_id=state.msg_id, text=state.text())
            return
        except TelegramError:
            pass  # message gone or not editable: pin a new one
    msg = tg("sendMessage", chat_id=chat_id, text=state.text(), disable_notification=True)
    tg("pinChatMessage", chat_id=chat_id, message_id=msg["message_id"], disable_notification=True)


# ---------------------------------------------------------------- main

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--daily", action="store_true", help="send the morning summary for today")
    mode.add_argument("--tomorrow", action="store_true", help="send the evening preview of tomorrow")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the message instead of sending it (no Telegram calls)")
    args = parser.parse_args()

    now, slots = build_slots(fetch_forecast())
    midnight = datetime.combine(now.date() + timedelta(days=1), datetime.min.time())
    until = midnight + timedelta(days=1) if args.tomorrow else max(midnight, now + LOOKAHEAD)
    require_coverage(now, slots, until)

    if args.daily:
        summary, warning, dry = daily_message(now, slots), None, None
    elif args.tomorrow:
        summary, warning, dry = tomorrow_message(now, slots), None, None
    else:
        summary, warning = None, hourly_message(now, slots)
        dry = None if warning else dry_again_message(now, slots)

    if args.dry_run:
        sys.stdout.reconfigure(encoding="utf-8")
        print(summary or warning or dry or "No rain expected in the next 3 hours; no alert would be sent.")
        return

    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    admin_ids = [c.strip() for c in os.environ.get("TELEGRAM_CHAT_ID", "").split(",") if c.strip()]
    if not token or not admin_ids:
        print("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set.", file=sys.stderr)
        sys.exit(1)

    failed = False
    states: dict[str, ChatState] = {}

    def read_state(chat_id: str) -> None:
        nonlocal failed
        try:
            states[chat_id] = load_state(chat_id, now.date())
        except TelegramError:
            failed = True
            states[chat_id] = ChatState()  # can't read it: default to warnings on

    # The owner (first id) keeps the list of people they approved in their pinned status.
    for chat_id in admin_ids:
        read_state(chat_id)
    for _, chat_id in states[admin_ids[0]].approved:
        if chat_id not in states:
            read_state(chat_id)

    # Decide what each chat gets before saving state, so a "dry again" can lift today's mute.
    outgoing = []
    for chat_id, state in states.items():
        if summary:
            outgoing.append((chat_id, summary, None))
        elif warning and state.on and not state.is_muted(now.date()):
            outgoing.append((chat_id, warning, WARNING_BUTTONS))
        elif dry and state.on:
            outgoing.append((chat_id, dry, None))
            if state.muted:
                state.muted, state.changed = None, True

    for chat_id, state in states.items():
        if state.changed:
            try:
                save_state(chat_id, state)
            except TelegramError:
                failed = True

    sent = 0
    for chat_id, text, buttons in outgoing:
        extra = {"reply_markup": buttons} if buttons else {}
        try:
            tg("sendMessage", chat_id=chat_id, text=text, **extra)
            sent += 1
        except TelegramError as exc:
            if exc.status == 403 and chat_id not in admin_ids:
                # An approved person blocked the bot or left their group: not our failure.
                print("An approved chat has blocked the bot; remove it with /users.", file=sys.stderr)
            else:
                failed = True

    if not outgoing:
        print("No rain expected in the next 3 hours; nothing sent." if not (warning or dry)
              else "Warnings are off or muted in every chat; nothing sent.")
    print(f"Sent {sent} message(s) to {len(states)} chat(s).")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
