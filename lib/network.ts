import { getApiBaseUrlCandidates } from "@/lib/attendance-api";
import { getSettings } from "@/lib/storage";

export async function isBackendReachable(timeoutMs = 3000): Promise<boolean> {
  const settings = await getSettings();
  if (settings.offlineMode === "true") {
    return false;
  }

  const apiBases = await getApiBaseUrlCandidates();
  const perCandidateTimeout = Math.max(
    700,
    Math.floor(timeoutMs / Math.max(1, apiBases.length))
  );
  try {
    for (const apiBase of apiBases) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), perCandidateTimeout);
      try {
        const response = await fetch(`${apiBase}/health`, {
          method: "GET",
          signal: controller.signal,
        });
        if (response.ok) {
          return true;
        }
      } catch {
        // Try next candidate.
      } finally {
        clearTimeout(timer);
      }
    }
    return false;
  } catch {
    return false;
  }
}
