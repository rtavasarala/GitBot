import { notifyPermissionsChanged, type SessionStore } from "./server-common";
import { respondPermission as opencodePermission } from "./start-opencode";

export async function resolvePermission(
  store: SessionStore,
  toolUseID: string,
  approved: boolean,
  updatedInput?: unknown,
  denyMessage = "User denied",
): Promise<boolean> {
  const pending = store.pendingPermissions.get(toolUseID);
  if (!pending) return false;

  if (store.agent === "claude-code") {
    store.pendingPermissions.delete(toolUseID);
    notifyPermissionsChanged();
    pending.resolve(approved
      ? { behavior: "allow", updatedInput: updatedInput ?? pending.input }
      : { behavior: "deny", message: denyMessage });
    return true;
  }

  if (store.agent === "opencode" && store.sdkSessionId) {
    store.pendingPermissions.delete(toolUseID);
    notifyPermissionsChanged();
    const respondSdkId = pending.askedBySdkSessionId ?? store.sdkSessionId;
    await opencodePermission(respondSdkId, toolUseID, approved, store.repoPath).catch((error: any) => {
      console.error("Permission response failed:", error.message);
    });
    return true;
  }

  return false;
}
