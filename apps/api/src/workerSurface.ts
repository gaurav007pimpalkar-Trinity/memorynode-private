/**
 * Which Worker entry is handling the request. Public API excludes control-plane-only routes.
 */

export type WorkerRequestSurface = "public" | "control_plane";
