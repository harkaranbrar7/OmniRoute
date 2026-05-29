# 🚀 OmniRoute — Local Dev Setup Guide

This branch (`dev-setup`) includes a pre-filled `.env` file ready for local development.

## Prerequisites

- **Node.js** `>=22.22.3` — recommended: `v22.x LTS` (use [nvm](https://github.com/nvm-sh/nvm))
- **npm** `>=10`
- **Redis** (optional but needed for rate limiting — install via `brew install redis` or `sudo apt install redis`)

> ⚠️ If you don't want Redis, comment out `REDIS_URL` in `.env`.

---

## 1. Clone your fork & switch to this branch

```bash
git clone https://github.com/harkaranbrar7/OmniRoute.git
cd OmniRoute
git checkout dev-setup
```

## 2. Install dependencies

```bash
npm install
```

> If you see native module errors (better-sqlite3, etc.), run:
> ```bash
> npm rebuild better-sqlite3
> ```

## 3. The `.env` is already set up!

The `.env` file on this branch has safe local defaults. Just verify:
- `JWT_SECRET` and `API_KEY_SECRET` are set (they are, with dev placeholders)
- `INITIAL_PASSWORD=CHANGEME` — **change this after first login**
- `PORT=20128` — dashboard at `http://localhost:20128`

## 4. Start the dev server

```bash
npm run dev
```

OmniRoute will start on **http://localhost:20128**.

---

## 5. First Run

1. Open **http://localhost:20128** in your browser
2. Login with password: `CHANGEME` (then change it in Settings → Security)
3. Go to **Providers** → connect a free provider:
   - **Kiro AI** — free Claude (no credit card)
   - **Pollinations** — GPT/Claude/Gemini, no signup
   - **Qoder** — unlimited free DeepSeek/Kimi
4. Go to **Endpoints** → copy your API key
5. Point any AI tool at: `http://localhost:20128/v1`

---

## 6. Connect to Claude Code / Cursor / Cline

```
Base URL: http://localhost:20128/v1
API Key:  <your key from Dashboard → Endpoints>
Model:    auto
```

---

## Quick Commands

| Command | Description |
|---|---|
| `npm run dev` | Start local dev server (hot reload) |
| `npm run build` | Production build |
| `npm start` | Start production server |
| `npm test` | Run unit tests |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Port 20128 in use | Change `PORT=` in `.env` |
| Redis connection error | Comment out `REDIS_URL` in `.env` or start Redis |
| Node version error | Use `nvm use 22` |
| Native module errors | Run `npm rebuild` |

---

> 💡 This setup is for **localhost only**. For production/VPS, see [Docker Guide](docs/guides/DOCKER_GUIDE.md).
