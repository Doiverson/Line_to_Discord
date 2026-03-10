# LINE to Discord Worker

Cloudflare Workers + Hono + TypeScript を使って、LINE Messaging API の webhook を Discord webhook に転送する最小構成のサンプルです。

## Flow

```text
LINE -> Cloudflare Workers (Hono) -> Discord Webhook
```

## Endpoint

- `POST /webhook/line`

## Environment Variables

- `LINE_CHANNEL_SECRET`
- `DISCORD_WEBHOOK_URL`

ローカル開発では `.dev.vars` を使います。

```dotenv
LINE_CHANNEL_SECRET="your-line-channel-secret"
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/your-webhook-url"
```

## Local Development

依存関係をインストールします。

```bash
pnpm install
```

ローカルサーバーを起動します。

```bash
pnpm run dev
```

別ターミナルで Cloudflare Tunnel を起動すると、LINE Developers から webhook を検証できます。

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

もし `wrangler dev` が別ポートで起動した場合は、そのポートに合わせてください。

## Deploy

GitHub に push し、Cloudflare Workers の Git integration / Workers Builds でこのリポジトリを接続します。

必要な設定:

- Worker name: `line-to-discord`
- Install command: `pnpm install --frozen-lockfile`
- Deploy command: `pnpm run deploy`

Cloudflare Dashboard の `Variables & Secrets` に次の secrets を登録します。

- `LINE_CHANNEL_SECRET`
- `DISCORD_WEBHOOK_URL`

## Files

```text
.
├── src/index.ts
├── package.json
├── tsconfig.json
└── wrangler.jsonc
```
