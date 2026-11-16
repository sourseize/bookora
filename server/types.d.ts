import type { UserRole } from "./auth.js";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        name: string;
        role: UserRole;
        businessId: string | null;
        sessionId: string;
        sessionExpiresAt: string;
      };
    }
  }
}

export {};
