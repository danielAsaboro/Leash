import { redirect } from "next/navigation";

/** Home → Chat, Leash's primary surface. The paper is reached via the rail (`/paper`). */
export default function Home() {
  redirect("/chat");
}
