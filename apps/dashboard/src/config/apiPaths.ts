export const API_PATHS = {
  dashboard: {
    session: "/v1/dashboard/session",
    logout: "/v1/dashboard/logout",
    bootstrap: "/v1/dashboard/bootstrap",
    workspaces: "/v1/dashboard/workspaces",
    apiKeys: "/v1/dashboard/api-keys",
    revokeApiKey: "/v1/dashboard/api-keys/revoke",
    members: "/v1/dashboard/members",
    updateMemberRole: "/v1/dashboard/members/role",
    removeMember: "/v1/dashboard/members/remove",
    invites: "/v1/dashboard/invites",
    revokeInvite: "/v1/dashboard/invites/revoke",
  },
  billing: {
    status: "/v1/billing/status",
    checkout: "/v1/billing/checkout",
  },
  memories: {
    create: "/v1/memories",
  },
  context: {
    resolve: "/v1/context",
  },
  usage: {
    today: "/v1/usage/today",
  },
  connectors: {
    settings: "/v1/connectors/settings",
  },
} as const;

