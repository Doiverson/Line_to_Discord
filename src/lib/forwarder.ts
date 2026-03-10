import { sendDiscordImageMessage, sendDiscordTextMessage } from './discord';
import { getSenderName, resolveDiscordFiles } from './line';
import type { ForwardableEvent } from '../types';

export async function forwardEventsToDiscord({
  accessToken,
  discordWebhookUrl,
  events,
}: {
  accessToken: string;
  discordWebhookUrl: string;
  events: ForwardableEvent[];
}): Promise<void> {
  const profileCache = new Map<string, Promise<string>>();

  for (const event of events) {
    const senderName = await getSenderName({
      accessToken,
      cache: profileCache,
      source: event.source,
    });

    if (event.kind === 'text') {
      await sendDiscordTextMessage({
        senderName,
        text: event.text,
        webhookUrl: discordWebhookUrl,
      });
      continue;
    }

    const uploadResult = await resolveDiscordFiles(accessToken, event.images);
    if (uploadResult.files.length === 0) {
      console.error('Skipping LINE image event because no image content could be fetched');
      continue;
    }

    await sendDiscordImageMessage({
      files: uploadResult.files,
      skippedImages: uploadResult.skippedImages,
      senderName,
      webhookUrl: discordWebhookUrl,
    });
  }
}
