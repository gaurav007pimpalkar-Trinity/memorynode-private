const WORKSPACE_STORAGE_KEY = "mn_workspace_id";

export function loadWorkspaceId(): string {
  try {
    return localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function persistWorkspaceId(id: string): void {
  try {
    if (id) {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, id);
    } else {
      localStorage.removeItem(WORKSPACE_STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}
