# ECIT Site Tracker - Telegram Bot Worker

A Cloudflare Worker that connects a Telegram Bot to your ECIT Site Tracker Supabase database. It allows site engineers to send site progress updates, photos, and snags in a 1-on-1 Telegram chat, analyzes them using AI (Cloudflare Workers AI Llama-3.2 Vision or Gemini Flash), presents an interactive confirmation card, and updates the database with live sync upon confirmation.

---

## 🏗️ How It Works

1. **Engineer sends a message or photo** to the Telegram Bot:
   - Example 1: `Level 2 Room 204 screed complete`
   - Example 2: Attach photo with caption: `L1 R105 - Ceiling grid done, hairline crack near door (Plastering)`
2. **AI Analysis**:
   - Cloudflare Workers AI parses the room code, level, finish type (`F01..F16`, `W01..W09`, etc.), status (`pending`, `ongoing`, `done`), snags, and attaches inspection photos.
3. **Interactive Confirmation**:
   - The bot replies with a summary preview card and two inline buttons: `[ ✅ Confirm & Save ]` and `[ ❌ Cancel ]`.
4. **Live Update**:
   - Tapping **Confirm** uploads the photo to the Supabase `photos` storage bucket and updates the `rooms` table in Supabase.
   - The ECIT Tracker web/PWA app receives the update live via Supabase Realtime!

---

## 🚀 Setup & Deployment Guide

### 1. Create a Telegram Bot
1. Open Telegram and search for `@BotFather`.
2. Send `/newbot` and follow the prompts to choose a name and username (e.g. `ecit_tracker_bot`).
3. Copy the **HTTP API Bot Token** provided by BotFather.

---

### 2. Configure Cloudflare Secrets
Inside the `telegram-bot-worker` directory:

```bash
cd telegram-bot-worker

# 1. Set your Telegram Bot Token
npx wrangler secret put TELEGRAM_BOT_TOKEN

# 2. Set your Supabase Service Role Secret Key
# (Found in Supabase Dashboard -> Project Settings -> API -> service_role secret)
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY

# 3. (Optional) Set Google Gemini API Key if you want Gemini 1.5/2.0 Flash as an alternative vision model
npx wrangler secret put GEMINI_API_KEY
```

---

### 3. Deploy the Worker to Cloudflare

```bash
npx wrangler deploy
```

Wrangler will output your live worker URL, for example:
`https://ecit-telegram-bot.<your-subdomain>.workers.dev`

---

### 4. Register the Telegram Webhook

You can register the webhook with a single browser click or curl!

**Option A (Easiest):**
Open your browser and navigate to:
```
https://ecit-telegram-bot.<your-subdomain>.workers.dev/setup-webhook
```
You will receive: `{"ok": true, "result": true, "description": "Webhook was set"}`.

**Option B (Via curl):**
```bash
curl -F "url=https://ecit-telegram-bot.<your-subdomain>.workers.dev/webhook" \
  https://api.telegram.org/bot<YOUR_TELEGRAM_BOT_TOKEN>/setWebhook
```

---

## 🧪 Testing

1. Open your Telegram Bot in a 1-on-1 chat.
2. Send `/start` — the bot should greet you.
3. Send a test photo or message:
   `Level 2 Room 204 screed complete`
4. The bot will reply with the confirmation card:
   `[ ✅ Confirm & Save ]`  `[ ❌ Cancel ]`
5. Tap **Confirm** and watch your ECIT Tracker app update live!
