import { Hono } from 'hono'

type Bindings = {
  LINE_CHANNEL_SECRET: string
  LINE_CHANNEL_ACCESS_TOKEN: string
  DISCORD_WEBHOOK_URL: string
}

type LineWebhookBody = {
  events?: LineEvent[]
}

type LineSource =
  | {
      type: 'user'
      userId?: string
    }
  | {
      type: 'group'
      userId?: string
      groupId?: string
    }
  | {
      type: 'room'
      userId?: string
      roomId?: string
    }
  | {
      type?: string
      userId?: string
      groupId?: string
      roomId?: string
    }

type LineContentProvider =
  | {
      type: 'line'
    }
  | {
      type: 'external'
      originalContentUrl?: string
      previewImageUrl?: string
    }
  | {
      type?: string
      originalContentUrl?: string
      previewImageUrl?: string
    }

type LineEvent = {
  type?: string
  source?: LineSource
  message?: {
    id?: string
    type?: string
    text?: string
    contentProvider?: LineContentProvider
  }
}

type TextMessageEvent = LineEvent & {
  message: {
    type: 'text'
    text: string
  }
}

type ImageMessageEvent = LineEvent & {
  message: {
    id?: string
    type: 'image'
    contentProvider?: LineContentProvider
  }
}

type ForwardableEvent =
  | {
      kind: 'text'
      source?: LineSource
      text: string
    }
  | {
      kind: 'image'
      source?: LineSource
      images: LineImageReference[]
    }

type LineImageReference =
  | {
      kind: 'line'
      messageId: string
    }
  | {
      kind: 'external'
      url: string
    }

type ForwardableLineMessage = {
  senderName: string
  text: string
}

type DiscordFileUpload = {
  blob: Blob
  filename: string
}

type DiscordPayload = {
  allowed_mentions: {
    parse: []
  }
  content: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.post('/webhook/line', async (c) => {
  const signature = c.req.header('x-line-signature')

  if (!signature) {
    return c.json({ error: 'Missing LINE signature' }, 401)
  }

  const lineChannelSecret = c.env.LINE_CHANNEL_SECRET
  const lineChannelAccessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN
  const discordWebhookUrl = c.env.DISCORD_WEBHOOK_URL

  if (!lineChannelSecret || !lineChannelAccessToken || !discordWebhookUrl) {
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

  const forwardableEvents = extractForwardableEvents(payload)

  if (forwardableEvents.length > 0) {
    c.executionCtx.waitUntil(
      forwardEventsToDiscord({
        accessToken: lineChannelAccessToken,
        discordWebhookUrl,
        events: forwardableEvents,
      }).catch((error) => {
        console.error('Failed to forward LINE event(s) to Discord', error)
      }),
    )
  }

  return c.json({ ok: true }, 200)
})

app.onError((error, c) => {
  console.error('Unhandled application error', error)
  return c.json({ error: 'Internal Server Error' }, 500)
})

function extractForwardableEvents(payload: LineWebhookBody): ForwardableEvent[] {
  const events = Array.isArray(payload.events) ? payload.events : []
  const forwardableEvents: ForwardableEvent[] = []

  for (const event of events) {
    if (isTextMessageEvent(event)) {
      const text = event.message.text.trim()
      if (text.length > 0) {
        forwardableEvents.push({
          kind: 'text',
          source: event.source,
          text,
        })
      }

      continue
    }

    if (isImageMessageEvent(event)) {
      const imageReference = toLineImageReference(event.message)
      if (!imageReference) {
        continue
      }

      forwardableEvents.push({
        kind: 'image',
        source: event.source,
        images: [imageReference],
      })
    }
  }

  return mergeAdjacentImageEvents(forwardableEvents)
}

function mergeAdjacentImageEvents(events: ForwardableEvent[]): ForwardableEvent[] {
  const mergedEvents: ForwardableEvent[] = []

  for (const event of events) {
    const previousEvent = mergedEvents.at(-1)

    if (
      previousEvent &&
      previousEvent.kind === 'image' &&
      event.kind === 'image' &&
      hasSameSender(previousEvent.source, event.source)
    ) {
      previousEvent.images.push(...event.images)
      continue
    }

    mergedEvents.push(event)
  }

  return mergedEvents
}

async function forwardEventsToDiscord({
  accessToken,
  discordWebhookUrl,
  events,
}: {
  accessToken: string
  discordWebhookUrl: string
  events: ForwardableEvent[]
}): Promise<void> {
  const profileCache = new Map<string, Promise<string>>()

  for (const event of events) {
    const senderName = await getSenderName({
      accessToken,
      cache: profileCache,
      source: event.source,
    })

    if (event.kind === 'text') {
      await sendDiscordJson(discordWebhookUrl, {
        allowed_mentions: { parse: [] },
        content: formatDiscordTextMessage({
          senderName,
          text: event.text,
        }),
      })
      continue
    }

    const uploadResult = await resolveDiscordFiles(accessToken, event.images)
    if (uploadResult.files.length === 0) {
      console.error('Skipping LINE image event because no image content could be fetched')
      continue
    }

    await sendDiscordImages({
      files: uploadResult.files,
      skippedImages: uploadResult.skippedImages,
      senderName,
      webhookUrl: discordWebhookUrl,
    })
  }
}

async function sendDiscordJson(webhookUrl: string, payload: DiscordPayload): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Discord webhook returned ${response.status}: ${errorBody}`)
  }
}

async function sendDiscordImages({
  files,
  skippedImages,
  senderName,
  webhookUrl,
}: {
  files: DiscordFileUpload[]
  skippedImages: number
  senderName: string
  webhookUrl: string
}): Promise<void> {
  const fileChunks = chunk(files, 10)

  for (let index = 0; index < fileChunks.length; index += 1) {
    const fileChunk = fileChunks[index]
    const payload = {
      allowed_mentions: { parse: [] as [] },
      attachments: fileChunk.map((file, attachmentIndex) => ({
        filename: file.filename,
        id: attachmentIndex,
      })),
      content: formatDiscordImageMessage({
        batchIndex: index,
        batchCount: fileChunks.length,
        imageCount: files.length,
        senderName,
        skippedImages,
      }),
    }

    const formData = new FormData()
    formData.append('payload_json', JSON.stringify(payload))

    for (let attachmentIndex = 0; attachmentIndex < fileChunk.length; attachmentIndex += 1) {
      const file = fileChunk[attachmentIndex]
      formData.append(`files[${attachmentIndex}]`, file.blob, file.filename)
    }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      body: formData,
    })

    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`Discord webhook returned ${response.status}: ${errorBody}`)
    }
  }
}

function formatDiscordTextMessage(message: ForwardableLineMessage): string {
  return `LINE / ${message.senderName}: ${message.text}`
}

function formatDiscordImageMessage({
  batchIndex,
  batchCount,
  imageCount,
  senderName,
  skippedImages,
}: {
  batchIndex: number
  batchCount: number
  imageCount: number
  senderName: string
  skippedImages: number
}): string {
  const imageLabel = imageCount === 1 ? 'sent an image' : `sent ${imageCount} images`
  const parts = [`LINE / ${senderName} ${imageLabel}`]

  if (batchCount > 1) {
    parts.push(`(${batchIndex + 1}/${batchCount})`)
  }

  if (skippedImages > 0 && batchIndex === 0) {
    const skippedLabel =
      skippedImages === 1 ? '1 image could not be fetched' : `${skippedImages} images could not be fetched`
    parts.push(`- ${skippedLabel}`)
  }

  return parts.join(' ')
}

async function resolveDiscordFiles(
  accessToken: string,
  images: LineImageReference[],
): Promise<{
  files: DiscordFileUpload[]
  skippedImages: number
}> {
  const results = await Promise.allSettled(
    images.map((image, index) => fetchDiscordFile(accessToken, image, index)),
  )

  const files: DiscordFileUpload[] = []
  let skippedImages = 0

  for (const result of results) {
    if (result.status === 'fulfilled') {
      files.push(result.value)
      continue
    }

    skippedImages += 1
    console.error('Failed to fetch LINE image content', result.reason)
  }

  return { files, skippedImages }
}

async function fetchDiscordFile(
  accessToken: string,
  image: LineImageReference,
  index: number,
): Promise<DiscordFileUpload> {
  const response =
    image.kind === 'line'
      ? await fetch(
          `https://api-data.line.me/v2/bot/message/${encodeURIComponent(image.messageId)}/content`,
          {
            headers: {
              authorization: `Bearer ${accessToken}`,
            },
          },
        )
      : await fetch(image.url)

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Image fetch returned ${response.status}: ${errorBody}`)
  }

  const contentType = normalizeContentType(response.headers.get('content-type'))
  const extension = inferFileExtension(contentType, image)
  const bytes = await response.arrayBuffer()

  return {
    blob: new Blob([bytes], { type: contentType }),
    filename: `line-image-${index + 1}${extension}`,
  }
}

function normalizeContentType(contentType: string | null): string {
  return contentType?.split(';', 1)[0].trim() || 'application/octet-stream'
}

function inferFileExtension(contentType: string, image: LineImageReference): string {
  const explicitExtensions: Record<string, string> = {
    'application/octet-stream': '.bin',
    'image/gif': '.gif',
    'image/heic': '.heic',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
  }

  const mappedExtension = explicitExtensions[contentType]
  if (mappedExtension) {
    return mappedExtension
  }

  if (image.kind === 'external') {
    try {
      const url = new URL(image.url)
      const lastSegment = url.pathname.split('/').filter(Boolean).at(-1)
      const extension = lastSegment?.match(/\.[a-zA-Z0-9]{2,5}$/)?.[0]
      if (extension) {
        return extension.toLowerCase()
      }
    } catch {
      // Ignore malformed external URLs and fall back to .bin.
    }
  }

  return '.bin'
}

function toLineImageReference(
  message: ImageMessageEvent['message'],
): LineImageReference | null {
  if (message.contentProvider?.type === 'external') {
    const originalContentUrl = message.contentProvider.originalContentUrl
    if (!originalContentUrl) {
      return null
    }

    return {
      kind: 'external',
      url: originalContentUrl,
    }
  }

  if (typeof message.id === 'string' && message.id.length > 0) {
    return {
      kind: 'line',
      messageId: message.id,
    }
  }

  return null
}

function hasSameSender(left?: LineSource, right?: LineSource): boolean {
  const leftKey = getProfileCacheKey(left)
  const rightKey = getProfileCacheKey(right)

  return leftKey !== null && leftKey === rightKey
}

async function getSenderName({
  accessToken,
  cache,
  source,
}: {
  accessToken: string
  cache: Map<string, Promise<string>>
  source?: LineSource
}): Promise<string> {
  const cacheKey = getProfileCacheKey(source)

  if (!cacheKey) {
    return 'LINE User'
  }

  const cachedName = cache.get(cacheKey)
  if (cachedName) {
    return cachedName
  }

  const pendingName = fetchLineDisplayName(accessToken, source).catch((error) => {
    console.error('Failed to fetch LINE sender profile', error)
    return fallbackSenderName(source)
  })

  cache.set(cacheKey, pendingName)
  return pendingName
}

async function fetchLineDisplayName(
  accessToken: string,
  source?: LineSource,
): Promise<string> {
  const profileUrl = buildLineProfileUrl(source)
  if (!profileUrl) {
    return fallbackSenderName(source)
  }

  const response = await fetch(profileUrl, {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`LINE profile API returned ${response.status}: ${errorBody}`)
  }

  const profile = (await response.json()) as { displayName?: unknown }
  if (typeof profile.displayName !== 'string' || profile.displayName.trim().length === 0) {
    return fallbackSenderName(source)
  }

  return profile.displayName.trim()
}

function buildLineProfileUrl(source?: LineSource): string | null {
  const userId = source?.userId
  if (!userId) {
    return null
  }

  switch (source.type) {
    case 'user':
      return `https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`
    case 'group':
      if (!source.groupId) {
        return null
      }

      return `https://api.line.me/v2/bot/group/${encodeURIComponent(source.groupId)}/member/${encodeURIComponent(userId)}`
    case 'room':
      if (!source.roomId) {
        return null
      }

      return `https://api.line.me/v2/bot/room/${encodeURIComponent(source.roomId)}/member/${encodeURIComponent(userId)}`
    default:
      return null
  }
}

function getProfileCacheKey(source?: LineSource): string | null {
  const userId = source?.userId
  if (!userId) {
    return null
  }

  switch (source.type) {
    case 'user':
      return `user:${userId}`
    case 'group':
      return source.groupId ? `group:${source.groupId}:${userId}` : null
    case 'room':
      return source.roomId ? `room:${source.roomId}:${userId}` : null
    default:
      return null
  }
}

function fallbackSenderName(source?: LineSource): string {
  if (!source?.userId) {
    return 'LINE User'
  }

  return `LINE User (${source.userId.slice(0, 6)})`
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

function isTextMessageEvent(event: LineEvent): event is TextMessageEvent {
  return (
    event.type === 'message' &&
    event.message?.type === 'text' &&
    typeof event.message.text === 'string'
  )
}

function isImageMessageEvent(event: LineEvent): event is ImageMessageEvent {
  return event.type === 'message' && event.message?.type === 'image'
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

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }

  return chunks
}

export default app
