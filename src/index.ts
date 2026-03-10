import { Hono } from 'hono';

type Bindings = {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  DISCORD_WEBHOOK_URL: string;
};

type LineWebhookBody = {
  events?: LineEvent[];
};

type LineSource =
  | {
      type: 'user';
      userId?: string;
    }
  | {
      type: 'group';
      userId?: string;
      groupId?: string;
    }
  | {
      type: 'room';
      userId?: string;
      roomId?: string;
    }
  | {
      type?: string;
      userId?: string;
      groupId?: string;
      roomId?: string;
    };

type LineEvent = {
  type?: string;
  source?: LineSource;
  message?: {
    type?: string;
    text?: string;
  };
};

type TextLineMessage = {
  source?: LineSource;
  type: 'text';
  text: string;
};

type ForwardableLineMessage = {
  senderName: string;
  text: string;
};

type TextMessageEvent = LineEvent & {
  message: {
    type: 'text';
    text: string;
  };
};

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

  // Read the raw body exactly once so the same payload can be used for both
  // LINE signature verification and JSON parsing.
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

  const textMessages = extractTextMessages(payload);

  if (textMessages.length > 0) {
    // Return 200 immediately and forward to Discord in the background.
    c.executionCtx.waitUntil(
      forwardMessagesToDiscord({
        accessToken: lineChannelAccessToken,
        discordWebhookUrl,
        messages: textMessages,
      }).catch((error) => {
        console.error('Failed to forward LINE message(s) to Discord', error);
      }),
    );
  }

  return c.json({ ok: true }, 200);
});

app.onError((error, c) => {
  console.error('Unhandled application error', error);
  return c.json({ error: 'Internal Server Error' }, 500);
});

function extractTextMessages(payload: LineWebhookBody): TextLineMessage[] {
  const events = Array.isArray(payload.events) ? payload.events : [];

  return events
    .filter(isTextMessageEvent)
    .map((event) => ({
      source: event.source,
      type: 'text' as const,
      text: event.message.text.trim(),
    }))
    .filter((message) => message.text.length > 0);
}

async function forwardMessagesToDiscord({
  accessToken,
  discordWebhookUrl,
  messages,
}: {
  accessToken: string;
  discordWebhookUrl: string;
  messages: TextLineMessage[];
}): Promise<void> {
  const profileCache = new Map<string, Promise<string>>();
  const forwardableMessages = await Promise.all(
    messages.map(async (message) => {
      const senderName = await getSenderName({
        accessToken,
        cache: profileCache,
        source: message.source,
      });

      return {
        senderName,
        text: message.text,
      };
    }),
  );

  await Promise.all(
    forwardableMessages.map((message) => sendToDiscord(discordWebhookUrl, formatDiscordMessage(message))),
  );
}

async function sendToDiscord(webhookUrl: string, content: string): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Discord webhook returned ${response.status}: ${errorBody}`);
  }
}

function formatDiscordMessage(message: ForwardableLineMessage): string {
  return `${message.senderName}: ${message.text}`;
}

async function getSenderName({
  accessToken,
  cache,
  source,
}: {
  accessToken: string;
  cache: Map<string, Promise<string>>;
  source?: LineSource;
}): Promise<string> {
  const cacheKey = getProfileCacheKey(source);

  if (!cacheKey) {
    return 'LINE User';
  }

  const cachedName = cache.get(cacheKey);
  if (cachedName) {
    return cachedName;
  }

  const pendingName = fetchLineDisplayName(accessToken, source).catch((error) => {
    console.error('Failed to fetch LINE sender profile', error);
    return fallbackSenderName(source);
  });

  cache.set(cacheKey, pendingName);
  return pendingName;
}

async function fetchLineDisplayName(accessToken: string, source?: LineSource): Promise<string> {
  const profileUrl = buildLineProfileUrl(source);
  if (!profileUrl) {
    return fallbackSenderName(source);
  }

  const response = await fetch(profileUrl, {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`LINE profile API returned ${response.status}: ${errorBody}`);
  }

  const profile = (await response.json()) as { displayName?: unknown };
  if (typeof profile.displayName !== 'string' || profile.displayName.trim().length === 0) {
    return fallbackSenderName(source);
  }

  return profile.displayName.trim();
}

function buildLineProfileUrl(source?: LineSource): string | null {
  const userId = source?.userId;
  if (!userId) {
    return null;
  }

  switch (source.type) {
    case 'user':
      return `https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`;
    case 'group':
      if (!source.groupId) {
        return null;
      }

      return `https://api.line.me/v2/bot/group/${encodeURIComponent(source.groupId)}/member/${encodeURIComponent(userId)}`;
    case 'room':
      if (!source.roomId) {
        return null;
      }

      return `https://api.line.me/v2/bot/room/${encodeURIComponent(source.roomId)}/member/${encodeURIComponent(userId)}`;
    default:
      return null;
  }
}

function getProfileCacheKey(source?: LineSource): string | null {
  const userId = source?.userId;
  if (!userId) {
    return null;
  }

  switch (source.type) {
    case 'user':
      return `user:${userId}`;
    case 'group':
      return source.groupId ? `group:${source.groupId}:${userId}` : null;
    case 'room':
      return source.roomId ? `room:${source.roomId}:${userId}` : null;
    default:
      return null;
  }
}

function fallbackSenderName(source?: LineSource): string {
  if (!source?.userId) {
    return 'LINE User';
  }

  return `LINE User (${source.userId.slice(0, 6)})`;
}

async function verifyLineSignature(rawBody: string, signature: string, channelSecret: string): Promise<boolean> {
  const encoder = new TextEncoder();

  // Cloudflare Workers exposes the standard Web Crypto API, so no Node.js
  // crypto helpers are required here.
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const expectedSignature = arrayBufferToBase64(digest);

  return constantTimeEqual(expectedSignature, signature);
}

function isTextLineMessage(message: LineEvent['message']): message is TextLineMessage {
  return Boolean(message && message.type === 'text' && typeof message.text === 'string');
}

function isTextMessageEvent(event: LineEvent): event is TextMessageEvent {
  return event.type === 'message' && isTextLineMessage(event.message);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  if (aBytes.length !== bBytes.length) {
    return false;
  }

  let result = 0;

  for (let index = 0; index < aBytes.length; index += 1) {
    result |= aBytes[index] ^ bBytes[index];
  }

  return result === 0;
}

export default app;
