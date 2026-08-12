# Sexting Chat

A dead-simple chat: everyone meets in one **global room**, anyone can slip into a
**private 1-on-1**, and creators get **tips sent straight to their Cash App / Venmo**.

- **Creators** (the people who get tipped) sign up, set a display name, and link their
  Cash App / Venmo. They get a shareable profile at `/u/:id`.
- **Tippers / visitors** don't need an account. They pick a name and chat. From any
  creator's message they tap **💬 Chat & tip** to go private and see tip buttons.
- Money is **never handled by the app** — tip buttons open the creator's own Cash App /
  Venmo, so there's no payment processing or payouts to manage.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000 . A local SQLite file is created at `data/chat.db`.

## Deploy free on Render

Push this folder to a GitHub repo and create a **Web Service** from it (the included
`render.yaml` sets it up). Set `SESSION_SECRET` to a long random string.

Render's free disk is wiped on each deploy, so for data that survives deploys, create a
free [Turso](https://turso.tech) database and set `DATABASE_URL` + `DATABASE_AUTH_TOKEN`
(see `.env.example`). No code changes needed — it switches backends automatically.

## Stack

Node + Express + EJS + SQLite (`node:sqlite` locally, Turso in production). No native
build steps, so it deploys anywhere.
