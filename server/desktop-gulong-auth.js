import { getCollection } from "./db.js";
import { createScopedDesktopAuth } from "./desktop-english-auth.js";
import { createGulongEngineSessionStore } from "./desktop-english-sessions.js";
import { readGulongEngineEntitlement, GULONG_ENGINE_MONTHLY_PRICE_FEN } from "./english-coach-products.js";
import { registerWorkLuckyDesktopRoutes } from "./worklucky-desktop.js";

export const GULONG_ENGINE_DESKTOP_ROOT = "/api/v1/desktop/gulong-engine";

export function createGulongEngineDesktopAuth(dependencies = {}) {
  return createScopedDesktopAuth({
    root: GULONG_ENGINE_DESKTOP_ROOT,
    tokenPrefix: "gge",
    scope: "gulong-engine-desktop",
    authKind: "desktop-gulong-engine",
    loginAccountSummary: true,
    sessions: dependencies.sessions || createGulongEngineSessionStore({ getCollection }),
    readEntitlement: dependencies.readEntitlement || readGulongEngineEntitlement,
    ...dependencies,
  });
}

const production = createGulongEngineDesktopAuth();
export const registerGulongEngineDesktopAuthRoutes = production.register;
export const authenticateGulongEngineDesktop = production.authenticate;
export function registerWorkLuckyDesktopAuthRoutes(app) {
  registerWorkLuckyDesktopRoutes(app, { createAuth: createGulongEngineDesktopAuth, readEntitlement: readGulongEngineEntitlement, monthlyPriceFen: GULONG_ENGINE_MONTHLY_PRICE_FEN });
}
