import { redirect } from "next/navigation";
import { getEditionDates } from "../../lib/queries.ts";
import { today } from "../../lib/date.ts";

/** Paper → the latest edition we have (or today's date if the paper is brand new). */
export const dynamic = "force-dynamic";

export default async function Paper() {
  const dates = await getEditionDates();
  redirect(`/${dates[0] ?? today()}`);
}
