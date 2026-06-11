import { redirect } from "next/navigation";

/** Research moved under Services (`/services/research`). Redirect old top-level links. */
export const dynamic = "force-dynamic";

export default function ResearchMoved() {
  redirect("/services/research");
}
