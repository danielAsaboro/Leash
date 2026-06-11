import { redirect } from "next/navigation";
import { getEditionDates } from "../../lib/queries.ts";
import { today } from "../../lib/date.ts";

/** Feed → the latest edition we have (or today's date if the feed is brand new). */
export const dynamic = "force-dynamic";

export default async function Feed() {
  const dates = await getEditionDates();
  redirect(`/feed/${dates[0] ?? today()}`);
}
