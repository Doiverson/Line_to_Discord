import type { DiscordFileUpload, DiscordPayload } from '../types';

export async function sendDiscordTextMessage({
  senderName,
  text,
  webhookUrl,
}: {
  senderName: string;
  text: string;
  webhookUrl: string;
}): Promise<void> {
  await sendDiscordJson(webhookUrl, {
    allowed_mentions: { parse: [] },
    content: `${senderName}選手: ${text}`,
  });
}

export async function sendDiscordImageMessage({
  files,
  skippedImages,
  senderName,
  webhookUrl,
}: {
  files: DiscordFileUpload[];
  skippedImages: number;
  senderName: string;
  webhookUrl: string;
}): Promise<void> {
  const fileChunks = chunk(files, 10);

  for (let index = 0; index < fileChunks.length; index += 1) {
    const fileChunk = fileChunks[index];
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
    };

    const formData = new FormData();
    formData.append('payload_json', JSON.stringify(payload));

    for (let attachmentIndex = 0; attachmentIndex < fileChunk.length; attachmentIndex += 1) {
      const file = fileChunk[attachmentIndex];
      formData.append(`files[${attachmentIndex}]`, file.blob, file.filename);
    }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Discord webhook returned ${response.status}: ${errorBody}`);
    }
  }
}

async function sendDiscordJson(webhookUrl: string, payload: DiscordPayload): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Discord webhook returned ${response.status}: ${errorBody}`);
  }
}

function formatDiscordImageMessage({
  batchIndex,
  batchCount,
  imageCount,
  senderName,
  skippedImages,
}: {
  batchIndex: number;
  batchCount: number;
  imageCount: number;
  senderName: string;
  skippedImages: number;
}): string {
  const imageLabel = imageCount === 1 ? 'sent an image' : `sent ${imageCount} images`;
  const parts = [`${senderName}選手: ${imageLabel}`];

  if (batchCount > 1) {
    parts.push(`(${batchIndex + 1}/${batchCount})`);
  }

  if (skippedImages > 0 && batchIndex === 0) {
    const skippedLabel =
      skippedImages === 1 ? '1 image could not be fetched' : `${skippedImages} images could not be fetched`;
    parts.push(`- ${skippedLabel}`);
  }

  return parts.join(' ');
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}
