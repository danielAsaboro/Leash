import { redirect } from "next/navigation";
import { ASSISTANT_KIT, kitModels } from "../../lib/leash/kit.ts";
import { readDeviceBootstrap } from "../../lib/leash/device-bootstrap.ts";
import { WelcomeFlow, type WelcomeStage } from "../../components/onboarding/WelcomeFlow.tsx";

export const dynamic = "force-dynamic";

function parseStage(value: string | string[] | undefined, fallback: WelcomeStage): WelcomeStage {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "choose" || raw === "review" || raw === "sync" || raw === "prepare" ? raw : fallback;
}

export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const bootstrap = readDeviceBootstrap();
  if (bootstrap?.ready) redirect("/home");

  const params = await searchParams;
  const fallbackStage: WelcomeStage = bootstrap?.mode === "sync-existing" ? "sync" : "choose";
  const initialStage = parseStage(params["stage"], fallbackStage);

  return (
    <WelcomeFlow
      bootstrap={bootstrap}
      roles={ASSISTANT_KIT}
      modelNames={kitModels()}
      initialStage={initialStage}
    />
  );
}
