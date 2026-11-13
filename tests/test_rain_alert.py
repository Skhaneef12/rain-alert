"""Offline tests for rain-alert/rain_alert.py. Nothing leaves the machine.

Run from the repository root:  python -m unittest discover -s tests -v
"""
import io
import os
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "rain-alert"))
import rain_alert as ra  # noqa: E402

NOW = datetime(2026, 10, 23, 10, 7)
TOKEN = "FAKE-TOKEN-0000"
OWNER, ANA, GROUP = "111", "222", "-100555"


def make_slots(now, rain_ranges, days=2, rain_mm=0.6):
    """15-minute slots from an hour before `now`; rain_ranges are (start, end) minutes from now."""
    out, t = [], (now - timedelta(hours=1)).replace(minute=now.minute // 15 * 15, second=0, microsecond=0)
    end = datetime.combine(now.date() + timedelta(days=days), datetime.min.time())
    while t < end:
        rel = (t - now).total_seconds() / 60
        rain = any(a <= rel < b for a, b in rain_ranges)
        out.append(ra.Slot(t, rain_mm if rain else 0.0, 80 if rain else 10))
        t += ra.SLOT
    return out


class Resp:
    def __init__(self, code, body=None):
        self.status_code, self._body = code, body or {}

    def json(self):
        return self._body


class FakeServices:
    """Fake Telegram + Worker settings API."""

    def __init__(self, chats=None, api_status=200):
        self.chats = chats if chats is not None else [{"id": OWNER, "on": True, "muted": None}]
        self.api_status = api_status
        self.sent, self.unmuted, self.blocked = [], [], set()

    def post(self, url, json, timeout):  # Telegram
        assert "api.telegram.org" in url
        method = url.rsplit("/", 1)[1]
        assert method == "sendMessage", f"unexpected Telegram call {method}"
        if str(json["chat_id"]) in self.blocked:
            return Resp(403, {"description": "Forbidden: bot was blocked by the user"})
        self.sent.append((str(json["chat_id"]), json["text"], json.get("reply_markup")))
        return Resp(200, {"ok": True, "result": {"message_id": 1}})

    def request(self, method, url, timeout, headers, **kw):  # Worker API
        assert headers["authorization"] == "Bearer s3cret"
        if self.api_status != 200:
            return Resp(self.api_status)
        if method == "GET" and url.endswith("/api/recipients"):
            return Resp(200, {"chats": self.chats})
        if method == "POST" and url.endswith("/api/unmute"):
            self.unmuted.append(kw["json"]["chat_id"])
            return Resp(200, {"ok": True})
        raise AssertionError(url)

    def to(self, chat):
        return [t for c, t, _ in self.sent if c == chat]


ENV = {"TELEGRAM_BOT_TOKEN": TOKEN, "TELEGRAM_CHAT_ID": OWNER,
       "WORKER_URL": "https://worker.example", "STATE_SECRET": "s3cret"}


def run(fake, args, now=NOW, slots=None, env=None):
    slots = make_slots(now, []) if slots is None else slots
    out, err, code = io.StringIO(), io.StringIO(), 0
    with mock.patch.dict(os.environ, env or ENV, clear=False), \
         mock.patch.object(ra.requests, "post", fake.post), \
         mock.patch.object(ra.requests, "request", fake.request), \
         mock.patch.object(ra, "fetch_forecast", lambda: {}), \
         mock.patch.object(ra, "build_slots", lambda d: (now, slots)), \
         mock.patch.object(ra.time, "sleep"), \
         mock.patch.object(sys, "argv", ["rain_alert.py", *args]), \
         redirect_stdout(out), redirect_stderr(err):
        os.environ.pop("SCHEDULED_AT", None)
        try:
            ra.main()
        except SystemExit as e:
            code = e.code or 0
    return code, out.getvalue(), err.getvalue()


class Messages(unittest.TestCase):
    def test_labels_by_lead_time(self):
        for start, label in ((0, "RAINING NOW"), (45, "RAIN IN ~1 HOUR"), (100, "RAIN IN ~2 HOURS")):
            msg = ra.hourly_message(NOW, make_slots(NOW, [(start, start + 60)]))
            self.assertTrue(msg.startswith(f"☔ {label}"), msg)
            self.assertLess(len(msg), 200)

    def test_no_warning_beyond_150_minutes(self):
        self.assertIsNone(ra.hourly_message(NOW, make_slots(NOW, [(150, 200)])))
        self.assertIsNone(ra.hourly_message(NOW, make_slots(NOW, [])))

    def test_dry_again_once(self):
        self.assertIn("DRY AGAIN", ra.dry_again_message(NOW, make_slots(NOW, [(-60, -8)])))
        self.assertIsNone(ra.dry_again_message(NOW, make_slots(NOW, [])))          # nothing fell
        self.assertIsNone(ra.dry_again_message(NOW, make_slots(NOW, [(-60, 30)])))  # still raining

    def test_daily_windows_and_advice(self):
        msg = ra.daily_message(NOW, make_slots(NOW, [(233, 413), (653, 713)]))  # 14:00-17:00, 21:00-22:00
        self.assertIn("14:00-17:00", msg)
        self.assertIn("21:00-22:00", msg)
        self.assertIn("Hang the clothes before 14:00.", msg)
        self.assertEqual(ra.daily_message(NOW, make_slots(NOW, [])),
                         "☀️ No rain expected today. Good day to dry clothes outside.")

    def test_daily_message_capped_below_400(self):
        now = datetime(2026, 10, 23, 0, 0)
        slots = [ra.Slot(now + timedelta(minutes=15 * i), 0.0, 100 if (i // 4) % 2 == 0 else 0) for i in range(96 * 2)]
        self.assertLess(len(ra.daily_message(now, slots)), 400)

    def test_tomorrow_preview(self):
        minutes_to_tomorrow_14 = (24 * 60 - (10 * 60 + 7)) + 14 * 60
        msg = ra.tomorrow_message(NOW, make_slots(NOW, [(minutes_to_tomorrow_14, minutes_to_tomorrow_14 + 180)]))
        self.assertTrue(msg.startswith("🌙 Tomorrow's rain forecast: 14:00-17:00"), msg)


class ForecastSafety(unittest.TestCase):
    def test_gap_in_forecast_exits_without_sending(self):
        fake = FakeServices()
        gap = [s for s in make_slots(NOW, [(45, 120)]) if s.start != datetime(2026, 10, 23, 15, 0)]
        code, out, err = run(fake, ["--daily"], slots=gap)
        self.assertEqual(code, 1)
        self.assertEqual(fake.sent, [])
        self.assertIn("missing data", err)

    def test_forecast_retries_then_succeeds(self):
        seq = [ra.requests.ReadTimeout(), ra.requests.ReadTimeout(), mock.Mock(status_code=200, json=lambda: {"ok": 1})]

        def get(*a, **k):
            x = seq.pop(0)
            if isinstance(x, Exception):
                raise x
            return x
        with mock.patch.object(ra.requests, "get", get), mock.patch.object(ra.time, "sleep") as sleep, \
             redirect_stderr(io.StringIO()):
            self.assertEqual(ra.fetch_forecast(), {"ok": 1})
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [10, 30])

    def test_forecast_gives_up_after_3(self):
        with mock.patch.object(ra.requests, "get", side_effect=ra.requests.ReadTimeout()), \
             mock.patch.object(ra.time, "sleep"), redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as e:
                ra.fetch_forecast()
        self.assertEqual(e.exception.code, 1)


class LateRuns(unittest.TestCase):
    def iso(self, ago):
        return (datetime.now(timezone.utc) - ago).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    def test_slightly_late_runs(self):
        with mock.patch.dict(os.environ, {"SCHEDULED_AT": self.iso(timedelta(minutes=10))}):
            self.assertFalse(ra.too_late())

    def test_very_late_run_skipped_without_network(self):
        calls = []
        with mock.patch.dict(os.environ, {**ENV, "SCHEDULED_AT": self.iso(timedelta(hours=4))}), \
             mock.patch.object(ra.requests, "get", lambda *a, **k: calls.append(1)), \
             mock.patch.object(ra.requests, "post", lambda *a, **k: calls.append(1)), \
             mock.patch.object(sys, "argv", ["rain_alert.py", "--tomorrow"]), redirect_stdout(io.StringIO()) as out:
            ra.main()
        self.assertEqual(calls, [])
        self.assertIn("too late", out.getvalue())

    def test_manual_run_never_late(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SCHEDULED_AT", None)
            self.assertFalse(ra.too_late())


class Recipients(unittest.TestCase):
    rain = make_slots(NOW, [(45, 120)])

    def test_warning_to_everyone_on_and_unmuted(self):
        fake = FakeServices([{"id": OWNER, "on": True, "muted": None},
                             {"id": ANA, "on": False, "muted": None},          # warnings off
                             {"id": GROUP, "on": True, "muted": "2026-10-23"}])  # clothes are in today
        code, out, err = run(fake, [], slots=self.rain)
        self.assertEqual(code, 0)
        self.assertEqual([c for c, _, _ in fake.sent], [OWNER])
        self.assertEqual(fake.sent[0][2], ra.WARNING_BUTTONS)
        self.assertIn("to 3 chat(s)", out)

    def test_yesterdays_mute_ignored(self):
        fake = FakeServices([{"id": OWNER, "on": True, "muted": "2026-10-22"}])
        run(fake, [], slots=self.rain)
        self.assertTrue(fake.to(OWNER))

    def test_summary_to_everyone_even_if_off(self):
        fake = FakeServices([{"id": OWNER, "on": True, "muted": None}, {"id": ANA, "on": False, "muted": None}])
        run(fake, ["--daily"], slots=self.rain)
        self.assertEqual({c for c, _, _ in fake.sent}, {OWNER, ANA})

    def test_dry_again_lifts_mute_via_worker(self):
        t = NOW + timedelta(hours=2)
        fake = FakeServices([{"id": OWNER, "on": True, "muted": t.date().isoformat()}])
        code, out, err = run(fake, [], now=t, slots=make_slots(t, [(-60, -8)]))
        self.assertTrue(any("DRY AGAIN" in x for x in fake.to(OWNER)))
        self.assertEqual(fake.unmuted, [OWNER])

    def test_settings_unavailable_alerts_owner_only_and_fails(self):
        fake = FakeServices(api_status=503)
        code, out, err = run(fake, [], slots=self.rain)
        self.assertEqual(code, 1)
        self.assertEqual([c for c, _, _ in fake.sent], [OWNER])
        self.assertIn("alerting the owner only", err)

    def test_missing_worker_config_alerts_owner_only(self):
        fake = FakeServices()
        env = {k: v for k, v in ENV.items() if k != "STATE_SECRET"}
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("STATE_SECRET", None)
            code, out, err = run(fake, ["--daily"], slots=self.rain, env=env)
        self.assertEqual(code, 1)
        self.assertEqual([c for c, _, _ in fake.sent], [OWNER])

    def test_blocked_approved_chat_doesnt_fail_run(self):
        fake = FakeServices([{"id": OWNER, "on": True, "muted": None}, {"id": ANA, "on": True, "muted": None}])
        fake.blocked = {ANA}
        code, out, err = run(fake, ["--daily"], slots=self.rain)
        self.assertEqual(code, 0)
        self.assertIn("/users", err)

    def test_owner_blocked_fails_run(self):
        fake = FakeServices()
        fake.blocked = {OWNER}
        code, out, err = run(fake, ["--daily"], slots=self.rain)
        self.assertEqual(code, 1)

    def test_token_never_printed(self):
        fake = FakeServices()

        def boom(url, json, timeout):
            raise ra.requests.ConnectionError(url)
        fake.post = boom
        code, out, err = run(fake, ["--daily"], slots=self.rain)
        self.assertNotIn(TOKEN, out + err)
        self.assertNotIn("s3cret", out + err)


if __name__ == "__main__":
    unittest.main()
