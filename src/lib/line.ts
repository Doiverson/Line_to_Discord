import type {
  DiscordFileUpload,
  ForwardableEvent,
  ImageMessageEvent,
  LineEvent,
  LineImageReference,
  LineSource,
  LineWebhookBody,
  TextMessageEvent,
} from '../types';

export function extractForwardableEvents(payload: LineWebhookBody): ForwardableEvent[] {
  const events = Array.isArray(payload.events) ? payload.events : [];
  const forwardableEvents: ForwardableEvent[] = [];

  for (const event of events) {
    if (isTextMessageEvent(event)) {
      const text = event.message.text.trim();
      if (text.length > 0) {
        forwardableEvents.push({
          kind: 'text',
          source: event.source,
          text,
        });
      }

      continue;
    }

    if (isImageMessageEvent(event)) {
      const imageReference = toLineImageReference(event.message);
      if (!imageReference) {
        continue;
      }

      forwardableEvents.push({
        kind: 'image',
        source: event.source,
        images: [imageReference],
      });
    }
  }

  return mergeAdjacentImageEvents(forwardableEvents);
}

export async function getSenderName({
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

export async function resolveDiscordFiles(
  accessToken: string,
  images: LineImageReference[],
): Promise<{
  files: DiscordFileUpload[];
  skippedImages: number;
}> {
  const results = await Promise.allSettled(images.map((image, index) => fetchDiscordFile(accessToken, image, index)));
  const files: DiscordFileUpload[] = [];
  let skippedImages = 0;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      files.push(result.value);
      continue;
    }

    skippedImages += 1;
    console.error('Failed to fetch LINE image content', result.reason);
  }

  return { files, skippedImages };
}

export async function verifyLineSignature(
  rawBody: string,
  signature: string,
  channelSecret: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
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

function mergeAdjacentImageEvents(events: ForwardableEvent[]): ForwardableEvent[] {
  const mergedEvents: ForwardableEvent[] = [];

  for (const event of events) {
    const previousEvent = mergedEvents.at(-1);

    if (
      previousEvent &&
      previousEvent.kind === 'image' &&
      event.kind === 'image' &&
      hasSameSender(previousEvent.source, event.source)
    ) {
      previousEvent.images.push(...event.images);
      continue;
    }

    mergedEvents.push(event);
  }

  return mergedEvents;
}

function isTextMessageEvent(event: LineEvent): event is TextMessageEvent {
  return (
    event.type === 'message' &&
    event.message?.type === 'text' &&
    typeof event.message.text === 'string'
  );
}

function isImageMessageEvent(event: LineEvent): event is ImageMessageEvent {
  return event.type === 'message' && event.message?.type === 'image';
}

function toLineImageReference(message: ImageMessageEvent['message']): LineImageReference | null {
  if (message.contentProvider?.type === 'external') {
    const originalContentUrl = message.contentProvider.originalContentUrl;
    if (!originalContentUrl) {
      return null;
    }

    return {
      kind: 'external',
      url: originalContentUrl,
    };
  }

  if (typeof message.id === 'string' && message.id.length > 0) {
    return {
      kind: 'line',
      messageId: message.id,
    };
  }

  return null;
}

function hasSameSender(left?: LineSource, right?: LineSource): boolean {
  const leftKey = getProfileCacheKey(left);
  const rightKey = getProfileCacheKey(right);

  return leftKey !== null && leftKey === rightKey;
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

async function fetchDiscordFile(
  accessToken: string,
  image: LineImageReference,
  index: number,
): Promise<DiscordFileUpload> {
  const response =
    image.kind === 'line'
      ? await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(image.messageId)}/content`, {
          headers: {
            authorization: `Bearer ${accessToken}`,
          },
        })
      : await fetch(image.url);

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Image fetch returned ${response.status}: ${errorBody}`);
  }

  const contentType = normalizeContentType(response.headers.get('content-type'));
  const extension = inferFileExtension(contentType, image);
  const bytes = await response.arrayBuffer();

  return {
    blob: new Blob([bytes], { type: contentType }),
    filename: `line-image-${index + 1}${extension}`,
  };
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
      return source.groupId
        ? `https://api.line.me/v2/bot/group/${encodeURIComponent(source.groupId)}/member/${encodeURIComponent(userId)}`
        : null;
    case 'room':
      return source.roomId
        ? `https://api.line.me/v2/bot/room/${encodeURIComponent(source.roomId)}/member/${encodeURIComponent(userId)}`
        : null;
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

function normalizeContentType(contentType: string | null): string {
  return contentType?.split(';', 1)[0].trim() || 'application/octet-stream';
}

function inferFileExtension(contentType: string, image: LineImageReference): string {
  const explicitExtensions: Record<string, string> = {
    'application/octet-stream': '.bin',
    'image/gif': '.gif',
    'image/heic': '.heic',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
  };

  const mappedExtension = explicitExtensions[contentType];
  if (mappedExtension) {
    return mappedExtension;
  }

  if (image.kind === 'external') {
    try {
      const url = new URL(image.url);
      const lastSegment = url.pathname.split('/').filter(Boolean).at(-1);
      const extension = lastSegment?.match(/\.[a-zA-Z0-9]{2,5}$/)?.[0];
      if (extension) {
        return extension.toLowerCase();
      }
    } catch {
      // Ignore malformed external URLs and fall back to .bin.
    }
  }

  return '.bin';
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
