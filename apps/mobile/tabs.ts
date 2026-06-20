export type Route =
  | "home"
  | "chat"
  | "feed"
  | "brain"
  | "activity"
  | "alerts"
  | "economy"
  | "mesh"
  | "services"
  | "settings";

export type PrimaryRoute = Exclude<Route, "settings">;

export interface AppTab {
  key: Route;
  label: string;
}

export const PRIMARY_TABS: { key: PrimaryRoute; label: string }[] = [
  { key: "home", label: "Home" },
  { key: "chat", label: "Chat" },
  { key: "feed", label: "Feed" },
  { key: "brain", label: "Brain" },
  { key: "activity", label: "Activity" },
  { key: "alerts", label: "Alerts" },
  { key: "economy", label: "Economy" },
  { key: "mesh", label: "Mesh" },
  { key: "services", label: "Services" },
];

export const SETTINGS_TAB: AppTab = { key: "settings", label: "Settings" };
