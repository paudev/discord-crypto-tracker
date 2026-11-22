# Discord Crypto Tracker

A standalone, **free API** Discord price dashboard with **slash commands**. Vercel hosts the Discord HTTPS interactions endpoint and REST API; a separate Cloudflare Worker schedules price refreshes **every minute**. No GitHub Actions or always-on process. This repository does not touch `discord-server-stats` or `p2e-discord-bot`.

## Features

- Supports Solana and EVM networks: Solana, Ethereum, Base, BSC, Arbitrum, Polygon, Avalanche, Ronin (where supported by DEX Screener).
- Uses the public [DEX Screener API](https://docs.dexscreener.com/api/reference); **no API key required**. Looks up pools by token contract address and chooses the **highest USD-liquidity pool where that token is the base asset**, to avoid showing the quote token's price by mistake.
- Price, 5-minute and 24-hour price change, market cap (or separately labeled FDV), liquidity, contract address, DEX Screener chart link.
- Up to 12 dynamically tracked tokens in **one continually edited Discord message containing one embed**. Use a saturated, stable **Discord blurple accent (`#5865F2`)** for the card border (never red/green as a misleading overall market signal), and **⬆️ gain / ⬇️ loss / ➖ flat** solely as *price-action* indicators for 24h and 5m. No token-specific emojis or arbitrary icon selection; token symbols and chain names come from DEX Screener or saved configuration. MC is bold and on one line, followed by an airy change row and price/liquidity row; a shortened contract, clickable DEX chart, plus **opening, between-token, and closing** subtle dividers all remain. No ASCII box frames, separate token embeds, new channels, or GitHub Actions.
- `/tracker add chain:solana address:<token-CA>` — add a token. On first use, the dashboard appears in the channel where you run the command.
- `/tracker remove address:<token-CA>` — remove a token (optionally select network if duplicated).
- `/tracker list` — show tracked chains, contracts and the dashboard channel.
- `/tracker storage target:#crypto-tracker-data` — select the existing private data channel (you control its category and per-role visibility).
- `/tracker cleanup` — safely merge watchlists and remove duplicate bot-created data channels with no unrelated messages.
- `/tracker channel target:#crypto-prices` — move the dashboard.
- `/tracker refresh` — refresh immediately.
- `/tracker help` — show commands.
- **Manage Server** Discord permission required for all `/tracker` commands; replies are private (ephemeral).
- **You select the storage channel** with `/tracker storage target:#your-private-data-channel`. The bot no longer automatically creates `crypto-tracker-data` channels. Drag the selected channel to any category and configure which roles/members can View Channel in Discord; the bot preserves its category and permission overrides. A short marker in the channel topic lets the bot find it even if renamed. The bot shows a **readable private storage embed**; machine-readable JSON is collapsed behind a spoiler in that embed. Existing raw JSON messages are upgraded in place when the watchlist is next accessed or the scheduler runs. Do not delete the storage message. `/tracker cleanup` conservatively merges watchlists and removes safe bot-created duplicate data channels only when explicitly invoked.
- Only one current dashboard message; refreshes edit it instead of spamming chat.

## Deployment architecture

```text
Discord slash commands
        │ (HTTPS, signed Ed25519)
        ▼
Vercel /api/interactions   ◄── Cloudflare Worker (cron: once/minute)
        │                       │
        ├── /api/register       └── POST /api/refresh (secret)
        ├── Discord REST API (private config + public dashboard)
        └── DEX Screener (free prices)
```

The Discord bot uses **outgoing interactions**, not the persistent Discord Gateway connection. This is why it can run on Vercel serverless. The Cloudflare Worker is a **different deployment** and acts solely as a free scheduler. Your existing Cloudflare account can host this separate Worker alongside the server-stats scheduler, subject to free usage limits.

## 1. Connect the new GitHub repository to Vercel

Import `paudev/discord-crypto-tracker` as its **own** Vercel project named `discord-crypto-tracker`. Use the production branch `main`. Vercel automatically deploys subsequent pushes. **Do not enable GitHub Actions.**

Vercel production domain: `https://discord-crypto-tracker.vercel.app`

## 2. Create a separate Discord application

1. Open <https://discord.com/developers/applications>, choose **New Application**, and name it **Crypto Tracker**.
2. Copy **Application ID**, **Public Key** (from General Information), and **Bot Token** (Bot tab). Never put secrets in GitHub.
3. In **Installation**, enable **Guild Install** with scopes `bot`, `applications.commands` and sufficient bot permissions: View Channels, Send Messages, Embed Links, Read Message History, Manage Channels, and Manage Roles (needed to manage the private configuration channel's permissions). Use **Add to server** to install the application in the desired guild.
4. Enable Discord Developer Mode to copy the **Server ID**.
5. In your new Vercel project's **Settings → Environment Variables**, configure for **Production**:

| Variable | Source |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Token from the **new crypto tracker** Discord application |
| `DISCORD_APPLICATION_ID` | New crypto tracker Application ID |
| `DISCORD_PUBLIC_KEY` | New crypto tracker Public Key |
| `DISCORD_GUILD_ID` | Your Discord server ID |
| `REFRESH_SECRET` | Strong random string (at least 16 characters), **same value** in Cloudflare Worker Secret |

Redeploy Vercel after adding/changing env variables, so the live functions read them. `GET /api/health` must return `"configured":true`.

6. Configure **Interactions Endpoint URL** in the Discord application's **General Information**:

   `https://discord-crypto-tracker.vercel.app/api/interactions`

   Save. Discord sends a signed PING and the endpoint replies with PONG. The endpoint must be reachable and correctly configured first.

## 3. Register slash commands

After the Vercel production environment variables are configured, register the commands using this **authenticated Vercel endpoint** (you do not need to run a local bot or push code):

```powershell
$secret = Read-Host "Enter your crypto tracker REFRESH_SECRET"
Invoke-RestMethod -Method Post -Uri "https://discord-crypto-tracker.vercel.app/api/register" -Headers @{ Authorization = "Bearer $secret" }
```

This registers one **guild-scoped `/tracker`** command with subcommands in your configured server. Guild command changes normally appear quickly.

## 4. Initialize the price dashboard

In a Discord text channel that the bot can post to (e.g. `#crypto-prices`):

- Create an existing private text channel wherever you like and set its channel permissions. Grant SpicyTracker View Channel, Read Message History, Send Messages and Manage Channels there. Run `/tracker storage target:#your-private-channel` from a separate public or admin command channel. The bot will never create a data channel automatically.
- Run `/tracker channel target:#crypto-prices` to choose the public dashboard destination, then `/tracker add chain:solana address:<CA>`.
- Or run `/tracker add` directly in the channel where you want the dashboard after storage is selected.
- Use `/tracker list` to inspect the watchlist. Use `/tracker remove` to remove by contract address.

The bot does not create storage channels automatically. The selected channel holds its configuration message; you may move it between categories, rename it, or change who can view it. Do not remove the storage marker from its topic or block SpicyTracker from viewing its own data. If duplicates already exist, run `/tracker cleanup` after selecting your preferred storage channel. The cleanup command skips anything with unrelated or unreadable messages.

## 5. Enable one-minute Cloudflare updates (free tier)

Create a separate **Cloudflare Worker** by connecting the **same crypto-tracker GitHub repository**, not the server-stats repository:

| Workers Builds setting | Value |
| --- | --- |
| Project name | `discord-crypto-tracker` |
| GitHub repository | `paudev/discord-crypto-tracker` |
| Branch | `main` |
| Root directory | Repository root `/` |
| Build command | Leave blank |
| Deploy command | `npx wrangler deploy` |

`wrangler.jsonc` already includes the Cron Trigger `* * * * *` (every minute) and Worker entry point `worker/index.js`.

After deploying, open Cloudflare Worker **Settings → Variables and Secrets** and add a Secret named **`REFRESH_SECRET`** equal to the Vercel value. Deploy the configuration. Check Worker Observability logs for successful ticks. You do not need to schedule anything in GitHub Actions or Vercel Cron.

The public `*.workers.dev` URL returns a static health response; it cannot trigger a refresh. Scheduled requests authenticate with Vercel using the Bearer secret.

## API

- `GET /api/health`: service health, boolean configuration readiness (no secrets disclosed)
- `POST /api/interactions`: Discord signed interactions endpoint. Requires Ed25519 signature, rejects invalid/stale requests, replies to Discord PING.
- `POST /api/register`: register admin-only server slash commands; requires `Authorization: Bearer REFRESH_SECRET`.
- `POST /api/refresh`: refresh dashboard; requires `Authorization: Bearer REFRESH_SECRET`. Returns `ok:true` even before any tokens are tracked (`initialized:false`).

## Safety and operating limits

- **Never share the bot token, Public Key is okay, and never commit secrets to the repository.**
- Token metadata can be misleading or spoofed by crypto projects. The tracker picks a relatively liquid pair but does **not** verify token authenticity or guarantee a price. Always verify the actual contract address.
- DEX Screener and Discord may rate-limit or temporarily fail. Price updates are best effort, not guaranteed every 60 seconds.
- The admin-only Discord data channel acts as a lightweight database; concurrent administrative changes may overwrite each other, so avoid issuing simultaneous `/tracker` mutations.
- Deleting the bot's private config message resets the watchlist. Save your contract addresses somewhere else if you need a backup.
- One-minute polling with up to 12 tokens is normally within DEX Screener's documented free rate limits, but upstream providers can change limits.

## Local tests

```sh
npm install
npm test
npm run check
```

## Permissions and channel organization

The storage channel belongs wherever you put it. Its role/member overwrites are never modified by the bot. Under **Edit Channel → Permissions**, deny **View Channel** to `@everyone`, allow **View Channel** for the roles or members you choose, and allow the bot **View Channel**, **Read Message History**, **Send Messages**, **Manage Channels** (required to mark the selected storage channel in its topic). Changes to a category can resync permissions, so inspect the channel after moving it. Admins with server-wide Administrator permission can always see it.

The price dashboard is a separate text channel, set with `/tracker channel`. You can restrict that channel to selected members the same way; give the bot View Channel, Send Messages, Embed Links and Read Message History. The watchlist contents include token addresses and dashboard IDs, never bot tokens or API secrets.

## Automatic updates and storage migration

For every-minute checks, deploy a **separate** Cloudflare Worker connected to `paudev/discord-crypto-tracker` on `main`, named `discord-crypto-tracker`, with `npx wrangler deploy` and a blank build command. The repo already contains the `* * * * *` cron schedule. In Worker **Settings → Variables and Secrets**, add `REFRESH_SECRET` equal to the one in the crypto-tracker Vercel project. The Worker calls `POST https://discord-crypto-tracker.vercel.app/api/refresh` every minute, which edits the **same dashboard message** rather than posting new messages. Cloudflare Workers Git integration and Cron Trigger must be deployed and active; Vercel deployments alone do not run scheduled refreshes.

The private storage message is a readable embed: tracked-token count, dashboard link, and watchlist appear first; the machine-readable configuration is in the collapsed spoiler **at the very bottom of the description**, after the watchlist. The parser accepts old raw JSON posts and new formatted embeds, so upgrades do not discard tracked tokens. Run `/tracker list` to upgrade the selected storage message immediately without triggering a dashboard update. Also check the bot can **View Channel, Send Messages, Embed Links, Read Message History** in the public dashboard channel, otherwise Discord returns HTTP 403 and scheduled refresh cannot post or edit it.

### Discord color and formatting constraints

Discord's normal embeds do not offer individually colored text or a custom card background. The bot uses a high-contrast **blurple (#5865F2) left border**, blue chart hyperlinks, and red/green price-chart emojis 📉/📈 only for actual movements. It does not use ANSI blocks, random icon mappings, additional token cards, or artificial box frames. Token identities remain dynamically resolved. The one dashboard message is updated in place.

## Observed market-cap high alerts

The bot can send a **new message** to a server-manager-selected text channel when a tracked token exceeds its previously sampled market cap. This is an **observed high since that token began tracking**, **not** a verified all-time historical high (DEX Screener's free pair endpoint does not return historical ATH). Only numeric `marketCap` is used; `fdv` does **not** count as market cap.

- `/tracker ath-channel target:#market-cap-alerts` enables notifications. Set `min-increase` optionally (0–100%); omitted = 0, which reports **each** newly recorded high.
- `/tracker ath-channel target:#market-cap-alerts min-increase:5` suppresses small records until market cap is at least 5% above the last notified high. Alerts can still be frequent if the market rises quickly.
- `/tracker ath-status` shows the destination, threshold, and each tracked token's observed high.
- `/tracker ath-off` disables new alerts but preserves recorded highs.

Alerts default to **off** until you choose a destination. The **first valid market-cap sample** for existing/legacy tokens establishes a baseline silently. When adding a new token, the live market cap is used as its baseline if present. The one-minute Cloudflare refresh records new highs in the private Discord storage message and posts alerts to the configured destination with bot View Channel, Send Messages and Embed Links permissions. Existing dashboard publishing still edits the same dashboard message. Failed alert deliveries are retried on a later sample without crashing dashboard updates. The saved internal keys `h` and `a` represent sampled high and last-notified high to remain within Discord's storage-message length limit for 12 tokens.

New slash commands require **one re-registration** using the existing authenticated `POST /api/register` endpoint after deployment. No new GitHub Actions or Cloudflare Worker is required.

## Dashboard design contract

Preserve all requirements together: one edited Discord message and one embed, dynamic token labels, no arbitrary/token-specific emoji mappings, vivid constant blurple accent (`#5865F2`), **⬆️/⬇️/➖ only for real price movement**, clear start/between/end dividers, comfortable whitespace, bold MC and value together on one line, 24h and 5m movements, price and liquidity, shortened CA, clickable chart, 12-token capacity, and safe empty/missing data. Keep existing private storage, slash commands, Cloudflare schedule, and Vercel configuration unchanged.
