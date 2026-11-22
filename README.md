# Discord Crypto Tracker

A standalone, **free API** Discord price dashboard with **slash commands**. Vercel hosts the Discord HTTPS interactions endpoint and REST API; a separate Cloudflare Worker schedules price refreshes **every minute**. No GitHub Actions or always-on process. This repository does not touch `discord-server-stats` or `p2e-discord-bot`.

## Features

- Supports Solana and EVM networks: Solana, Ethereum, Base, BSC, Arbitrum, Polygon, Avalanche, Ronin (where supported by DEX Screener).
- Uses the public [DEX Screener API](https://docs.dexscreener.com/api/reference); **no API key required**. Looks up pools by token contract address and chooses the **highest USD-liquidity pool where that token is the base asset**, to avoid showing the quote token's price by mistake.
- Price, 5-minute and 24-hour price change, market cap (or separately labeled FDV), liquidity, contract address, DEX Screener chart link.
- Up to 12 tracked tokens, displayed as **one compact Discord embed** edited in place. Price and 5m/24h changes share one line; market cap and liquidity share another; a shortened contract and chart link share the third. The accent and per-token symbols reflect price movement. `/tracker list` provides full contract addresses.
- `/tracker add chain:solana address:<token-CA>` — add a token. On first use, the dashboard appears in the channel where you run the command.
- `/tracker remove address:<token-CA>` — remove a token (optionally select network if duplicated).
- `/tracker list` — show tracked chains, contracts and the dashboard channel.
- `/tracker channel target:#crypto-prices` — initialize or move the dashboard.
- `/tracker refresh` — refresh immediately.
- `/tracker help` — show commands.
- **Manage Server** Discord permission required for all `/tracker` commands; replies are private (ephemeral).
- Automatically creates a **private `crypto-tracker-data` channel** that holds one JSON configuration message. This is the persistent source of truth for the watchlist and dashboard location, with no Redis, paid database or Vercel filesystem writes. Do not delete or alter that private channel or message.
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

- Run `/tracker channel target:#crypto-prices` to choose the destination, then `/tracker add chain:solana address:<CA>`.
- Or run `/tracker add` directly in the channel where you want the dashboard; that channel becomes the dashboard automatically.
- Use `/tracker list` to inspect the watchlist. Use `/tracker remove` to remove by contract address.

The bot automatically creates private `#crypto-tracker-data` to persist the watchlist, and posts one embed in the chosen destination. Avoid editing the configuration message or deleting that private channel.

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
