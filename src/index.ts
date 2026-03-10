import { Hono } from 'hono'

type Bindings = {
  LINE_CHANNEL_SECRET: string
  DISCORD_WEBHOOK_URL: string
}

type LineWebhookBody = {
  events?: LineEvent[]
}

type LineEvent = {
  type?: string
  message?: {
    type?: string
    text?: string
  }
}

type TextLineMessage = {
  type: 'text'
  text: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.post('/webhook/line', async (c) => {
  const signature = c.req.header('x-line-signature')

  if (!signature) {
    return c.json({ error: 'Missing LINE signature' }, 401)
  }

  const lineChannelSecret = c.env.LINE_CHANNEL_SECRET
  const discordWebhookUrl = c.env.DISCORD_WEBHOOK_URL

  if (!lineChannelSecret || !discordWebhookUrl) {
    console.error('Missing required environment variables')
    return c.json({ error: 'Server configuration error' }, 500)
  }

  // Read the raw body exactly once so the same payload can be used for both
  // LINE signature verification and JSON parsing.
  const rawBody = await c.req.text()
  const isValidSignature = await verifyLineSignature(
    rawBody,
    signature,
    lineChannelSecret,
  )

  if (!isValidSignature) {
    return c.json({ error: 'Invalid LINE signature' }, 401)
  }

  let payload: LineWebhookBody

  try {
    payload = JSON.parse(rawBody) as LineWebhookBody
  } catch (error) {
    console.error('Failed to parse LINE webhook payload', error)
    return c.json({ error: 'Invalid JSON payload' }, 400)
  }

  const textMessages = extractTextMessages(payload)

  if (textMessages.length > 0) {
    // Return 200 immediately and forward to Discord in the background.
    c.executionCtx.waitUntil(
      Promise.all(
        textMessages.map((message) =>
          sendToDiscord(discordWebhookUrl, `LINE: ${message}`),
        ),
      ).catch((error) => {
        console.error('Failed to forward LINE message(s) to Discord', error)
      }),
    )
  }

  return c.json({ ok: true }, 200)
})

app.onError((error, c) => {
  console.error('Unhandled application error', error)
  return c.json({ error: 'Internal Server Error' }, 500)
})

function extractTextMessages(payload: LineWebhookBody): string[] {
  const events = Array.isArray(payload.events) ? payload.events : []

  return events
    .filter((event) => event.type === 'message')
    .map((event) => event.message)
    .filter(isTextLineMessage)
    .map((message) => message.text.trim())
    .filter((text) => text.length > 0)
}

async function sendToDiscord(webhookUrl: string, content: string): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ content }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Discord webhook returned ${response.status}: ${errorBody}`)
  }
}

async function verifyLineSignature(
  rawBody: string,
  signature: string,
  channelSecret: string,
): Promise<boolean> {
  const encoder = new TextEncoder()

  // Cloudflare Workers exposes the standard Web Crypto API, so no Node.js
  // crypto helpers are required here.
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody))
  const expectedSignature = arrayBufferToBase64(digest)

  return constantTimeEqual(expectedSignature, signature)
}

function isTextLineMessage(message: LineEvent['message']): message is TextLineMessage {
  return Boolean(message && message.type === 'text' && typeof message.text === 'string')
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const aBytes = encoder.encode(a)
  const bBytes = encoder.encode(b)

  if (aBytes.length !== bBytes.length) {
    return false
  }

  let result = 0

  for (let index = 0; index < aBytes.length; index += 1) {
    result |= aBytes[index] ^ bBytes[index]
  }

  return result === 0
}

export default app
