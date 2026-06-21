export type DownloadStatus = {
  name?: string;
  state: "starting" | "downloading" | "done" | "error" | "cancelled";
  percentage: number;
  downloaded?: number;
  total?: number;
  pid?: number;
  startedAt?: number;
  updatedAt?: number;
  error?: string;
};

function isTransientDownloadProbeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch|networkerror|network request failed|econnrefused|couldn't connect|load failed/i.test(message);
}

export async function readDownloadStatus(
  name: string,
  opts: {
    fetchImpl?: typeof fetch;
    tolerateTransientErrors?: boolean;
  } = {},
): Promise<DownloadStatus | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`/api/leash/models/download?name=${encodeURIComponent(name)}`, { cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Couldn't read download state for ${name}.`);
    return (await res.json()) as DownloadStatus;
  } catch (error) {
    if (opts.tolerateTransientErrors && isTransientDownloadProbeError(error)) return null;
    throw error;
  }
}
