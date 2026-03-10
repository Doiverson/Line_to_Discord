import { Hono } from 'hono';
import { forwardEventsToDiscord } from './lib/forwarder';
import { extractForwardableEvents, verifyLineSignature } from './lib/line';
import type { Bindings, LineWebhookBody } from './types';

const app = new Hono<{ Bindings: Bindings }>();

app.post('/webhook/line', async (c) => {
  const signature = c.req.header('x-line-signature');

  if (!signature) {
    return c.json({ error: 'Missing LINE signature' }, 401);
  }

  const lineChannelSecret = c.env.LINE_CHANNEL_SECRET;
  const lineChannelAccessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
  const discordWebhookUrl = c.env.DISCORD_WEBHOOK_URL;

  if (!lineChannelSecret || !lineChannelAccessToken || !discordWebhookUrl) {
    console.error('Missing required environment variables');
    return c.json({ error: 'Server configuration error' }, 500);
  }

  const rawBody = await c.req.text();
  const isValidSignature = await verifyLineSignature(rawBody, signature, lineChannelSecret);

  if (!isValidSignature) {
    return c.json({ error: 'Invalid LINE signature' }, 401);
  }

  let payload: LineWebhookBody;

  try {
    payload = JSON.parse(rawBody) as LineWebhookBody;
  } catch (error) {
    console.error('Failed to parse LINE webhook payload', error);
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  const forwardableEvents = extractForwardableEvents(payload);

  if (forwardableEvents.length > 0) {
    c.executionCtx.waitUntil(
      forwardEventsToDiscord({
        accessToken: lineChannelAccessToken,
        discordWebhookUrl,
        events: forwardableEvents,
      }).catch((error) => {
        console.error('Failed to forward LINE event(s) to Discord', error);
      }),
    );
  }

  return c.json({ ok: true }, 200);
});

app.onError((error, c) => {
  console.error('Unhandled application error', error);
  return c.json({ error: 'Internal Server Error' }, 500);
});

export default app;
