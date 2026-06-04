import { redirect } from "next/navigation";
import { createChat } from "../../../lib/leash/chat-store.ts";

/** Always start a fresh conversation. */
export const dynamic = "force-dynamic";

export default async function NewChat() {
  const id = await createChat();
  redirect(`/chat/${id}`);
}
