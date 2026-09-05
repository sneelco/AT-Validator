import { useEffect } from "react";
import { toast } from "sonner";
import { useAppState } from "../store/useAppState";

/** Non-blocking toast when the sync engine auto-resolved a conflict (§8). */
export function ConflictBanner() {
  const notice = useAppState((s) => s.conflictNotice);
  useEffect(() => {
    if (!notice) return;
    toast.info(notice, {
      id: "sync-conflict",
      duration: 10_000,
      onDismiss: () => useAppState.getState().setSyncMeta({ conflictNotice: null, syncStatus: "synced" }),
      onAutoClose: () => useAppState.getState().setSyncMeta({ conflictNotice: null, syncStatus: "synced" }),
    });
  }, [notice]);
  return null;
}
