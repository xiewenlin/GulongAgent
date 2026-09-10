function bearerToken(c) {
  const authorization = String(c.req.header("authorization") || "");
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

export function createSiteOrDesktopChandlerAuthenticate({ authenticateSite, authenticateDesktop }) {
  return async function authenticateSiteOrDesktopChandler(c, { required = true, scopes = [] } = {}) {
    const siteAuth = await authenticateSite(c, { required: false, scopes });
    if (siteAuth) return siteAuth;

    const token = bearerToken(c);
    if (token && !token.startsWith("gla_live_")) {
      const desktop = await authenticateDesktop(c);
      if (desktop.error) return desktop;
      return {
        kind: "desktop-chandler",
        user: {
          ...desktop.user,
          id: desktop.user._id.toString(),
          role: desktop.identity.role,
          authProvider: "chandler",
        },
        session: null,
        desktop,
      };
    }

    if (!required) return null;
    return { error: c.json({ code: "UNAUTHORIZED", message: "请先登录或提供有效 API Key" }, 401) };
  };
}
