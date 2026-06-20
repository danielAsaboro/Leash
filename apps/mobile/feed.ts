export type FeedSection = "AI" | "COMPUTE" | "SOLANA" | "BRIEF";

export interface FeedChat {
  id: string;
  title: string;
  updatedAt: number;
  count: number;
}

export interface FeedTask {
  id: string;
  title: string;
  detail?: string;
  status: string;
  priority: string;
  updatedAt: number;
}

export interface FeedNotification {
  id: string;
  title: string;
  body: string;
  why?: string;
  tier: string;
  read: boolean;
  createdAt: number;
}

export interface FeedStory {
  id: string;
  section: FeedSection;
  kicker: string;
  headline: string;
  dek: string;
  updatedAt: number;
  target: "chat" | "activity" | "alerts";
  targetId?: string;
}

export function buildLocalFeedStories({
  chats,
  tasks,
  notifications,
}: {
  chats: FeedChat[];
  tasks: FeedTask[];
  notifications: FeedNotification[];
}): FeedStory[] {
  const taskStories: FeedStory[] = tasks.slice(0, 4).map((task) => ({
    id: `task:${task.id}`,
    section: "BRIEF",
    kicker: `${task.status.replace("_", " ")} · ${task.priority}`,
    headline: task.title,
    dek: task.detail?.trim() || "A live local TODO from this device's Activity ledger.",
    updatedAt: task.updatedAt,
    target: "activity",
  }));

  const notificationStories: FeedStory[] = notifications.slice(0, 4).map((notification) => ({
    id: `notification:${notification.id}`,
    section: "COMPUTE",
    kicker: notification.read ? notification.tier : `${notification.tier} · unread`,
    headline: notification.title,
    dek: notification.why?.trim() || notification.body,
    updatedAt: notification.createdAt,
    target: "alerts",
    targetId: notification.id,
  }));

  const chatStories: FeedStory[] = chats.slice(0, 4).map((chat) => ({
    id: `chat:${chat.id}`,
    section: "AI",
    kicker: `${chat.count} ${chat.count === 1 ? "message" : "messages"}`,
    headline: chat.title,
    dek: "A recent local conversation with your on-device assistant.",
    updatedAt: chat.updatedAt,
    target: "chat",
    targetId: chat.id,
  }));

  return [...taskStories, ...notificationStories, ...chatStories].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12);
}
