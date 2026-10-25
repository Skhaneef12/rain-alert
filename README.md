# Rain alert ☔

Telegram messages about rain at home, so the clothes drying outside get brought in on time.

- **Every morning at ~07:07** – a summary of the rain expected for the rest of the day (always sent, even on dry days, so you know the bot is alive).
- **Every hour from ~08:07 to ~20:07** – a warning when rain is starting now or within the next ~2 hours, and a "dry again" message when it stops.
- **Every evening at ~20:07** – a preview of tomorrow, so you can plan the laundry.
- **Instantly, from Telegram** – turn warnings on or off, mute them for the day with one tap, ask for the current outlook, and approve other people who want the alerts.

All times are Montevideo time (America/Montevideo, UTC-3). It uses the free [Open-Meteo](https://open-meteo.com/) forecast API (no API key) and two free services, with nothing running on your own computer:

| Part | Runs on | Does |
|---|---|---|
| [`rain-alert/rain_alert.py`](rain-alert/rain_alert.py) | GitHub Actions, on a schedule | Rain warnings, "dry again", morning and evening summaries |
| [`worker/src/index.js`](worker/src/index.js) | A Cloudflare Worker, always on | Replies to commands and buttons within seconds, handles access requests |

---

## Contents

- [Example messages](#example-messages)
- [Using the bot from Telegram](#using-the-bot-from-telegram)
- [Giving other people access](#giving-other-people-access)
- [How it works](#how-it-works)
- [Schedule](#schedule)
- [Setup from scratch](#setup-from-scratch)
- [Testing](#testing)
- [Configuration](#configuration)
- [Errors and exit codes](#errors-and-exit-codes)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Repository layout](#repository-layout)

---

## Example messages

**Hourly warning** (under 200 characters), with two buttons underneath: **👕 Clothes are in** and **🔕 Warnings off**:

```
☔ RAIN IN ~1 HOUR – Bring in the clothes. Rain around 14:15, 80% chance, 1.2 mm.
```

**Dry again** (sent once when the rain stops):

```
🌤 DRY AGAIN – The rain has stopped and none is expected for 3 hours. OK to hang the clothes out.
```

**Morning summary when rain is expected** (under 400 characters):

```
🌦 Today's rain forecast: 14:00-17:00 (peak 80%), 21:00-22:00 (peak 50%). Total ~4.2 mm. Hang the clothes before 14:00.
```

If it is already raining (or about to) when the summary is sent, the last sentence becomes:

```
No rain-free window before the first rain – keep the clothes inside.
```

**Morning summary on a dry day:**

```
☀️ No rain expected today. Good day to dry clothes outside.
```

**Evening preview of tomorrow:**

```
🌙 Tomorrow's rain forecast: 06:00-10:00 (peak 70%). Total ~3.1 mm. Hang the clothes before 06:00.
```

```
🌙 No rain expected tomorrow. Good day to dry clothes outside.
```

---

## Using the bot from Telegram

Everything here is answered within a few seconds.

| Send or tap | What it does |
|---|---|
| **👕 Clothes are in** (button on a warning) | No more warnings for the rest of today. You still get "dry again" (which lifts the mute, in case you hang the clothes out again) and the summaries. The mute ends by itself at midnight. |
| **🔕 Warnings off** (button) or `/off` | Stops warnings and "dry again" messages until you turn them back on. The morning and evening summaries keep coming, so you know the bot is still working. |
| **🔔 Warnings on** (button) or `/on` | Turns warnings back on and clears any mute. |
| `/now` | Replies with the next 3 hours and the rest of today's forecast. |
| `/status` | Says whether warnings are on, off or muted, and lists the commands. |
| `/help` or `/start` | Lists the commands. |
| `/users` *(owner only)* | Lists who has access, with a **🚫 Remove** button for each person. |

Typing `/` in the chat shows the command menu.

Settings take effect immediately, and the next scheduled alert respects them.

**The pinned message is the bot's memory.** The first time a setting changes, the bot pins a status message in that chat, such as:

```
📌 Rain alert status: OFF 🔕
Commands: /now /on /off /status
```

In the owner's chat it also lists who has access (`👤`) and who is waiting for approval (`⏳`). The Worker and the GitHub job both read this message. **Don't unpin or delete it**, and don't pin another message after it. If the owner's status message is lost, everyone else loses access until approved again, and warnings go back to ON.

---

## Giving other people access

Nobody needs to look up chat ids or change any settings.

1. **They** search for your bot in Telegram and send it any message.
2. **They** immediately get: *"👋 Hi! This bot sends rain alerts for one home. I've asked the owner to give you access…"*
3. **You** immediately get: *"👤 Ana (@ana_uy) wants rain alerts."* with **✅ Approve** and **❌ Decline** buttons.
4. **You tap Approve.** They immediately get *"✅ You're in!"* plus the command list. From the next scheduled check, they get everything you get.

Each approved person has their own on/off setting and their own **Clothes are in** mute. They can't approve anyone else, and they can't see who else has access.

- **Repeat messages** while a request is waiting don't send you another request; they just get *"still waiting"*.
- **Declined** people are told. They can ask again later, and you'll get a new request.
- **Removing someone:** send `/users` and tap **🚫 Remove** next to their name. They're told, and stop getting alerts from the next check.
- **Group chats:** someone adds the bot to a group and sends a message there; you get a request naming the group. Once approved, the whole group gets alerts and shares one setting, and anyone in the group can use the buttons. Make the bot a group **admin** that can pin messages, otherwise `/off` can't be remembered there.

The **owner** is the chat id in the `TELEGRAM_CHAT_ID` secret (GitHub) and `ADMIN_CHAT_IDS` (Cloudflare), both set during setup. Only the owner gets requests and can use `/users`.

---

## How it works

### Forecast data

Each scheduled run calls the Open-Meteo forecast API for the house's area (latitude `-34.91`, longitude `-56.15`) with `timezone=America/Montevideo` and asks for 3 days of:

| Variable | Resolution | Meaning |
|---|---|---|
| `minutely_15=precipitation` | every 15 minutes | mm of rain in that 15-minute slot |
| `hourly=precipitation_probability` | every hour | % chance of rain in that hour |

Open-Meteo labels each value with the **end** of its interval (a 15-minute value at 14:15 covers 14:00–14:15; an hourly value at 15:00 covers 14:00–15:00). The code converts everything to the **start** of the interval, so "rain around 14:00" means rain begins at 14:00. Each 15-minute slot is paired with the probability of the hour it falls in.

**Incomplete forecasts are never reported as "no rain".** Before writing any message, the script checks that every 15-minute slot it needs has both values: from now until midnight, or the next 3 hours if later, and all of tomorrow for the evening preview. If any are missing it stops with exit code 1 and sends nothing, the same as when the API is down. `/now` does the same check and replies that the forecast is incomplete.

### What counts as rain

A 15-minute slot counts as rain when **either** is true:

- precipitation ≥ **0.2 mm** in that slot, **or**
- the hour's precipitation probability ≥ **40 %**

Both thresholds can be changed without editing code (see [Configuration](#configuration)). The same rule is used by every message.

### Hourly warning

1. Look at the 15-minute slots from now until 3 hours ahead.
2. Find the first rain slot and how many minutes away it is.
3. Pick a label:

   | Minutes until rain | Message label |
   |---|---|
   | under 30 (or already raining) | `RAINING NOW` |
   | 30 – 89 | `RAIN IN ~1 HOUR` |
   | 90 – 149 | `RAIN IN ~2 HOURS` |
   | 150 or more, or no rain | *no warning* |

4. The message gives the start time of the rain, that hour's probability, and the total mm expected in the hour from that time (four 15-minute slots).

If rain is coming you will usually get a warning on several runs in a row ("~2 HOURS", then "~1 HOUR", then "RAINING NOW"), and `RAINING NOW` each hour while it rains. Tap **👕 Clothes are in** to stop them for the day.

### Dry again

On an hourly run with no warning: if the past hour had rain and the next 3 hours have none, it sends "dry again". Because the next run's past hour is dry, it is sent once per rain spell.

### Summaries (`--daily`, `--tomorrow`)

1. Take every 15-minute slot in the period: now until 23:59 for the morning summary, 00:00–23:59 tomorrow for the evening preview.
2. Group them into whole hours. An hour is rainy if any of its slots is rain.
3. Join consecutive rainy hours into windows such as `14:00-17:00`. A window that runs to midnight is shown as ending at `23:59`.
4. For each window report the **peak** probability; for the period report the **total** mm.
5. Add advice: `Hang the clothes before HH:MM` names the end of the dry period before the first rain, or the message says there is no rain-free window.
6. If there is no rain at all, send the sunny message instead.

If a very broken-up day would make the message 400 characters or longer, the last windows are replaced with `+N more`.

### Each scheduled run

1. Fetch the forecast and check it is complete.
2. Read the owner's pinned status (settings plus the approved list), then each approved chat's status.
3. Decide each chat's message: warnings skip chats that are off or muted, while summaries go to everyone.
4. Save any changed status messages, then send.

### The Worker

Telegram sends every message and button tap straight to the Worker (a "webhook"), signed with a secret only Telegram and the Worker know. Anything without that secret is refused. The Worker reads and writes the same pinned status messages, so the GitHub job always sees the latest settings.

---

## Schedule

The workflow is in [`.github/workflows/rain-alert.yml`](.github/workflows/rain-alert.yml). GitHub cron times are in **UTC**; Montevideo is UTC-3 all year (no daylight saving time).

| Cron (UTC) | Montevideo time | Runs |
|---|---|---|
| `7 10 * * *` | 07:07 | `python rain_alert.py --daily` |
| `7 11-22 * * *` | 08:07, 09:07 … 19:07 (12 runs) | `python rain_alert.py` |
| `7 23 * * *` | 20:07 | `python rain_alert.py`, then `python rain_alert.py --tomorrow` |

The runs are at minute 7 because GitHub is busiest at the top of each hour, when scheduled runs are most often late.

The job reads `github.event.schedule` to know which cron fired and picks the command from that. It can also be started by hand (**Actions → rain-alert → Run workflow**) with a choice of `hourly`, `daily` or `tomorrow`.

Each run checks out the repo, installs Python 3.12 and `requests`, then runs the script from the `rain-alert/` folder with the secrets and variables passed in as environment variables. Runs never overlap. The workflow only has read access to the repository.

> **This repository is public, so the 60-day rule applies.** GitHub turns off scheduled workflows in a public repository after 60 days without any commit. If the morning summary stops arriving, open **Actions → rain-alert** and click **Enable workflow**, or make any small commit. A calendar reminder every ~50 days avoids the gap.

---

## Setup from scratch

You only need this if you are setting the project up again (for example in a new repository or with a new bot).

### 1. Create the Telegram bot

1. In Telegram, open a chat with **@BotFather**.
2. Send `/newbot`, choose a display name and a username ending in `bot`.
3. BotFather replies with a **token** like `123456789:AA...`. Keep it private – anyone with it can control the bot.

### 2. Find your chat id

1. Open a chat with your new bot and send it any message (for example `hi`).
2. In a browser, open `https://api.telegram.org/bot<TOKEN>/getUpdates` (replace `<TOKEN>` with your token).
3. In the response, find `"chat":{"id":123456789,...}`. That number is your chat id.

If `getUpdates` returns `"result":[]`, send the bot another message and reload. Do this **before** step 5: once the Worker is connected, `getUpdates` no longer works. (Or skip steps 2–3 and use the `-GitHubRepo` shortcut in step 5.)

### 3. Add the two GitHub secrets

Repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

- `TELEGRAM_BOT_TOKEN` – the token
- `TELEGRAM_CHAT_ID` – your chat id (you become the owner)

Or with the GitHub CLI (it prompts for the value, so it is not saved in your shell history):

```bash
gh secret set TELEGRAM_BOT_TOKEN --repo <owner>/rain-alert
```

```bash
gh secret set TELEGRAM_CHAT_ID --repo <owner>/rain-alert
```

### 4. Push

Scheduled workflows only run from the repository's **default branch** (`main`). Once the files and secrets are there, the next cron time will run automatically.

### 5. Set up the Cloudflare Worker

Needs a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and [Node.js](https://nodejs.org/) on your computer (only for this setup).

1. Log in to Cloudflare from the terminal (opens your browser):

   ```bash
   npx --yes wrangler@4.145.0 login
   ```

2. Run the setup script from the repository root:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\worker\setup.ps1
   ```

   It asks for the bot token (hidden as you paste), then:
   - shows a short code such as `setup-4821`. Send exactly that to your bot, and the script uses it to find your chat id (the bot doesn't reply to anything else until setup finishes),
   - deploys the Worker (the first time, Cloudflare may ask you to choose a `workers.dev` subdomain),
   - saves `BOT_TOKEN`, `ADMIN_CHAT_IDS` and a random `WEBHOOK_SECRET` as Cloudflare secrets,
   - points Telegram at the Worker and sets up the command menu.

   It ends with `SETUP-DONE`. Send `/status` to your bot; the reply should arrive within seconds.

**Shortcut for a new repository:** add `-GitHubRepo <owner>/<repo>` and the script also saves `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` as that repository's GitHub secrets (using the GitHub CLI, `gh`, logged in to your account), so you can skip steps 2 and 3:

```powershell
powershell -ExecutionPolicy Bypass -File .\worker\setup.ps1 -GitHubRepo <owner>/rain-alert
```

Run the script again after changing `worker/wrangler.toml` or the Telegram setup. It's safe to repeat. For a code-only change to `worker/src/index.js`, deploying is enough (no token needed):

```bash
npx --yes wrangler@4.145.0 deploy --config worker/wrangler.toml
```

---

## Testing

### On GitHub (sends real messages)

**Actions → rain-alert → Run workflow → mode → Run workflow.**

- `daily` and `tomorrow` always send a message to everyone with access.
- `hourly` sends a warning only if rain is due within ~150 minutes (or "dry again" if rain just stopped); otherwise the log says `No rain expected in the next 3 hours; nothing sent.` and the run is still green.

From the command line:

```bash
gh workflow run rain-alert.yml -f mode=daily
```

### The Worker

Send `/status` or `/now` to the bot; replies should arrive within seconds. To watch what the Worker does while you test:

```bash
npx --yes wrangler@4.145.0 tail --config worker/wrangler.toml
```

### Locally (no message sent)

Requires Python 3.9+.

```bash
cd rain-alert
```

```bash
pip install -r requirements.txt
```

```bash
python rain_alert.py --dry-run
```

```bash
python rain_alert.py --daily --dry-run
```

```bash
python rain_alert.py --tomorrow --dry-run
```

`--dry-run` fetches the real forecast and prints the message instead of sending it. It makes no Telegram calls at all, so it does not need the secrets.

### Command-line options

| Option | Effect |
|---|---|
| *(none)* | Hourly warning / dry again |
| `--daily` | Morning summary for the rest of today |
| `--tomorrow` | Evening preview of tomorrow |
| `--dry-run` | Print the message instead of sending it; no Telegram calls |
| `-h`, `--help` | Show help |

`--daily` and `--tomorrow` cannot be used together.

---

## Configuration

### Rain thresholds (no code change needed)

| Setting | Default | What it changes |
|---|---|---|
| `RAIN_MM_THRESHOLD` | `0.2` | mm in a 15-minute slot that counts as rain |
| `RAIN_PROB_THRESHOLD` | `40` | hourly probability (%) that counts as rain |

They are set in **two places**. Keep them equal:

- **Scheduled alerts:** GitHub repository variables. Go to **Settings → Secrets and variables → Actions → Variables tab → New repository variable**, or:

  ```bash
  gh variable set RAIN_PROB_THRESHOLD --body 60 --repo <owner>/rain-alert
  ```

  The next run uses the new value. If a variable is not set, the default is used.

- **`/now` replies:** the `[vars]` section of [`worker/wrangler.toml`](worker/wrangler.toml). Change them there, then run `worker/setup.ps1` again to deploy.

Tips:

- **Too many warnings?** Raise `RAIN_PROB_THRESHOLD` (e.g. to `60`). Probability is usually what triggers false alarms.
- **Missing light drizzle?** Lower `RAIN_MM_THRESHOLD` (e.g. to `0.1`).

### In the code

Constants at the top of [`rain-alert/rain_alert.py`](rain-alert/rain_alert.py) (and the same ones at the top of [`worker/src/index.js`](worker/src/index.js)):

| Constant | Default | What it changes |
|---|---|---|
| `LATITUDE`, `LONGITUDE` | `-34.91`, `-56.15` | Where the forecast is for. Deliberately rounded to ~1 km so the public code doesn't pinpoint the house; Open-Meteo's forecast grid is coarser than that, so the forecast is the same as for the exact address. |
| `TIMEZONE` / `TZ` | `America/Montevideo` | Timezone of the forecast times and messages |
| `LOOKAHEAD` | 3 hours | How far ahead warnings and "dry again" look |

- **Different hours?** Edit the cron lines in the workflow. Remember they are UTC: Montevideo time + 3 hours. Also change the matching cron string in the `case` block of the workflow's `run:` step, because that is how it tells the runs apart.
- **Different location or timezone?** Change the constants in both files, and the cron times if the UTC offset differs.

---

## Errors and exit codes

Scheduled job (`rain_alert.py`):

| Situation | What happens | Exit code |
|---|---|---|
| Messages sent | Prints `Sent N message(s) to M chat(s).` | 0 |
| Hourly mode, no rain soon | Prints `No rain expected in the next 3 hours; nothing sent.` | 0 |
| Warning due, but every chat is off or muted | Prints `Warnings are off or muted in every chat; nothing sent.` | 0 |
| An approved person has blocked the bot | Prints a note to remove them with `/users`; everyone else still gets their message | 0 |
| Open-Meteo fails (network error, timeout, non-200, bad JSON) | Waits 5 s and retries once. If it fails again, prints `Forecast unavailable after retry; not sending anything.` **No guessed alert or summary is sent.** | 1 |
| Forecast has missing values | Prints `Forecast is missing data for <time>; not sending anything.` | 1 |
| `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` missing | Prints that they must be set | 1 |
| A Telegram call fails | Retried up to 3 times: after 5 s for network errors and server errors, after Telegram's requested wait for "too many requests" (429). Other errors (wrong token, wrong chat id) are not retried. The other chats still get their messages. | 1 |
| A pinned status can't be read | That chat is treated as warnings ON, so a warning is never lost by mistake | 1 |

A non-zero exit marks the GitHub Actions run as failed (red), and by default GitHub emails you about failed scheduled runs.

Worker: if something goes wrong while handling a message, it logs a one-line reason (visible with `wrangler tail`) and still answers Telegram, so the same message isn't redelivered over and over. If the forecast can't be fetched or is incomplete, `/now` says so rather than guessing.

---

## Security

- The bot token is stored only as a GitHub secret (`TELEGRAM_BOT_TOKEN`) and a Cloudflare secret (`BOT_TOKEN`). It is never written in the code or printed in logs. Error messages that could contain it, because the request URL holds the token, are replaced with the error type and HTTP status.
- The Worker only accepts requests that carry the random `WEBHOOK_SECRET`, which only Telegram and the Worker know. Anything else gets `403`.
- Only the owner can approve, decline or remove people. Commands and buttons from chats without access are ignored. A stranger can only trigger one access request, which you can decline.
- The approved list (names and chat ids) is visible only in the owner's private chat.
- The GitHub workflow has read-only access to the repository.
- If the token ever leaks, send `/revoke` to @BotFather to get a new one. Then update the GitHub secret and run `worker/setup.ps1` again.

---

## Troubleshooting

**No morning message at ~07:07**
- GitHub can start scheduled runs late, typically by 5–30 minutes and more at busy times. A run can occasionally be skipped altogether.
- Check **Actions → rain-alert** for a failed (red) run and open its log.
- Check that both secrets exist: **Settings → Secrets and variables → Actions**.

**Commands or buttons get no reply**
- Run `worker/setup.ps1` again. It re-deploys the Worker and reconnects Telegram to it.
- Watch the Worker while you send `/status`: `npx --yes wrangler@4.145.0 tail --config worker/wrangler.toml`.
- Using another tool that calls `setWebhook` or `deleteWebhook` on the same bot disconnects the Worker.

**Someone approved isn't getting alerts**
They're added from the next scheduled check. Send `/users` to confirm they're listed. If the owner's pinned status message was unpinned or deleted, the list is gone: they need to message the bot again and be re-approved.

**`/off` was forgotten**
The pinned status message was unpinned or deleted, or another message was pinned after it. Send `/off` again. In a group, make sure the bot is an admin that can pin messages.

**Run fails with `Telegram returned HTTP 401`**
The token is wrong or was revoked. Update `TELEGRAM_BOT_TOKEN`, and run `worker/setup.ps1` again for the Worker.

**Run fails with `Telegram returned HTTP 400`**
Usually a wrong owner chat id in `TELEGRAM_CHAT_ID`. Fix the secret. The Worker uses the id it found during setup.

**Run fails with `Telegram returned HTTP 403`**
You blocked the bot. Unblock it. (An approved person blocking it only prints a note, see above.)

**Run fails with `Forecast unavailable after retry` or `Forecast is missing data`**
Open-Meteo was down or sent an incomplete forecast. The next hourly run will try again; nothing needs to be done.

**Scheduled runs stopped completely**
- Check **Actions** → **rain-alert** is not disabled (a "This workflow was disabled" banner).
- In **public** repositories, GitHub disables scheduled workflows after 60 days without repository activity. Re-enable it in the Actions tab.
- In **private** repositories, runs use your GitHub Actions minutes. GitHub rounds each job up to a whole minute, so 14 runs a day is about 420 of the 2,000 free minutes a month on the Free plan.

**Getting the same warning every hour**
Expected while rain is coming or falling. Tap **👕 Clothes are in** to stop them for the day.

**Emoji show as `?` in a local `--dry-run` on Windows**
The script switches its own output to UTF-8 for `--dry-run`; if your terminal font lacks emoji they may still look wrong. The Telegram message itself is unaffected.

---

## Limitations

- It is only as good as the forecast. Short, local showers are hard for any forecast to pin down to the 15 minutes.
- Outside Central Europe and North America, Open-Meteo's 15-minute data is interpolated from hourly forecast models, so the timing is closer to "within the hour" than "to the minute".
- Warnings only run 08:07–20:07. There are no warnings at night.
- "Dry again" is worked out from the forecast for the past hour, not from measured rain.
- The rain rule exists twice, in Python for the scheduled alerts and in JavaScript for `/now`. A change to the logic needs making in both files.
- Everyone's access depends on the owner's pinned status message (see above).

---

## Repository layout

```
.
├── README.md                       This file
├── .github/
│   └── workflows/
│       └── rain-alert.yml          Schedules the alerts on GitHub Actions
├── rain-alert/
│   ├── rain_alert.py               Scheduled alerts (forecast → messages → Telegram)
│   └── requirements.txt            Python dependency: requests
└── worker/
    ├── src/index.js                Cloudflare Worker: commands, buttons, access requests
    ├── wrangler.toml               Worker name and /now thresholds
    └── setup.ps1                   One-time setup: deploy, secrets, connect Telegram
```
