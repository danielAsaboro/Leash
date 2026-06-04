import { redirect } from "next/navigation";
import { latestChat, createChat } from "../../lib/leash/chat-store.ts";

/** Chat home → resume the most recent conversation, or start a fresh one. */
export const dynamic = "force-dynamic";

export default async function ChatIndex() {
  const id = (await latestChat()) ?? (await createChat());
  redirect(`/chat/${id}`);
}
