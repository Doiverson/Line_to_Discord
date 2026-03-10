export type Bindings = {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  DISCORD_WEBHOOK_URL: string;
};

export type LineWebhookBody = {
  events?: LineEvent[];
};

export type LineSource =
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

export type LineContentProvider =
  | {
      type: 'line';
    }
  | {
      type: 'external';
      originalContentUrl?: string;
      previewImageUrl?: string;
    }
  | {
      type?: string;
      originalContentUrl?: string;
      previewImageUrl?: string;
    };

export type LineEvent = {
  type?: string;
  source?: LineSource;
  message?: {
    id?: string;
    type?: string;
    text?: string;
    contentProvider?: LineContentProvider;
  };
};

export type TextMessageEvent = LineEvent & {
  message: {
    type: 'text';
    text: string;
  };
};

export type ImageMessageEvent = LineEvent & {
  message: {
    id?: string;
    type: 'image';
    contentProvider?: LineContentProvider;
  };
};

export type LineImageReference =
  | {
      kind: 'line';
      messageId: string;
    }
  | {
      kind: 'external';
      url: string;
    };

export type ForwardableEvent =
  | {
      kind: 'text';
      source?: LineSource;
      text: string;
    }
  | {
      kind: 'image';
      source?: LineSource;
      images: LineImageReference[];
    };

export type DiscordFileUpload = {
  blob: Blob;
  filename: string;
};

export type DiscordPayload = {
  allowed_mentions: {
    parse: [];
  };
  content: string;
};
