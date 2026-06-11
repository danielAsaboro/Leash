import { redirect } from "next/navigation";

/** Home → Chat, Leash's primary surface. The feed is reached via the rail (`/feed`). */
export default function Home() {
  redirect("/chat");
}
