/**
 * The constitution — soul / goals / heartbeat — the mobile analogue of the desktop Brain's
 * Proactivity store (packages/leash-core constitution.ts). `soul` and `goals` are composed into
 * the live chat system prompt (App.tsx → buildSystem), so editing them genuinely changes how Leash
 * behaves. `heartbeat` describes what a proactive cycle would watch; on the phone there is no
 * background loop running it (that lives on the desktop Leash — stated honestly in the UI), but the
 * text is the user's authored intent and is kept here. One JSON file in the document directory.
 */
import * as FileSystem from "expo-file-system/legacy";

export type ConstitutionField = "soul" | "goals" | "heartbeat";

export type Constitution = { soul: string; goals: string; heartbeat: string };

export const DEFAULT_CONSTITUTION: Constitution = {
  soul:
    "You are Leash — a calm, private thinking partner that lives entirely on this device. " +
    "You are candid, concise, and never sycophantic. You protect the user's privacy as a first principle.",
  goals: "",
  heartbeat:
    "Each cycle, check whether anything the user asked you to watch has changed, surface one useful nudge at most, and stay quiet otherwise.",
};

export const FIELD_META: { key: ConstitutionField; label: string; blurb: string; rows: number }[] = [
  { key: "soul", label: "Soul", blurb: "Who you are — voice, values, boundaries. Fed into every chat.", rows: 7 },
  { key: "goals", label: "Goals", blurb: "Where you're going — what the user is working toward. Fed into every chat.", rows: 6 },
  { key: "heartbeat", label: "Heartbeat", blurb: "What a proactive cycle watches each beat (the loop itself runs on desktop Leash).", rows: 7 },
];

const FILE = `${FileSystem.documentDirectory}constitution.json`;

export async function getConstitution(): Promise<Constitution> {
  try {
    const info = await FileSystem.getInfoAsync(FILE);
    if (!info.exists) return { ...DEFAULT_CONSTITUTION };
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(FILE)) as Partial<Constitution>;
    return {
      soul: parsed.soul ?? DEFAULT_CONSTITUTION.soul,
      goals: parsed.goals ?? DEFAULT_CONSTITUTION.goals,
      heartbeat: parsed.heartbeat ?? DEFAULT_CONSTITUTION.heartbeat,
    };
  } catch {
    return { ...DEFAULT_CONSTITUTION };
  }
}

export async function setConstitution(field: ConstitutionField, value: string): Promise<void> {
  try {
    const cur = await getConstitution();
    const next = { ...cur, [field]: value };
    await FileSystem.writeAsStringAsync(FILE, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
}
