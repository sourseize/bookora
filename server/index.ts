import cookieParser from "cookie-parser";
import express, {
  type ErrorRequestHandler,
  type RequestHandler,
  type Response,
} from "express";
import { rateLimit } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  createOpaqueToken,
  createSession,
  clearSessionCookie,
  findPublicUser,
  hashPassword,
  hashToken,
  SESSION_COOKIE,
  setSessionCookie,
  type AuthUser,
  type UserRole,
  verifyPassword,
  verifyUnknownAccountPassword,
} from "./auth.js";
import { db } from "./db.js";
import {
  MailConfigurationError,
  sendAccountEmail,
  verifyEmailDelivery,
} from "./mailer.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const appOrigin = process.env.APP_ORIGIN ?? "http://localhost:5173";

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

const emailSchema = z.string().trim().email().max(254).transform((email) =>
  email.toLowerCase(),
);
const passwordSchema = z.string().min(12).max(128);
const registerSchema = z.discriminatedUnion("accountType", [
  z.object({
    accountType: z.literal("owner"),
    name: z.string().trim().min(2).max(80),
    email: emailSchema,
    password: passwordSchema,
    businessName: z.string().trim().min(2).max(100),
  }),
  z.object({
    accountType: z.literal("customer"),
    name: z.string().trim().min(2).max(80),
    email: emailSchema,
    password: passwordSchema,
  }),
]);
const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
const resetRequestSchema = z.object({ email: emailSchema });
const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});
const invitationSchema = z.object({ email: emailSchema });
const acceptInvitationSchema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().trim().min(2).max(80),
  password: passwordSchema,
});
const businessSettingsSchema = z.object({
  name: z.string().trim().min(2).max(100),
  timeZone: z.string().trim().min(1).max(100),
  locale: z.string().trim().min(2).max(40),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
});
const serviceSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(1000).default(""),
  durationMinutes: z.number().int().min(5).max(1440),
  priceMinor: z.number().int().min(0).max(1_000_000_000),
  priceCurrency: z
    .string()
    .trim()
    .length(3)
    .transform((value) => value.toUpperCase()),
  bufferMinutes: z.number().int().min(0).max(240).default(0),
  category: z.string().trim().max(60).default(""),
  onlineBooking: z.boolean().default(true),
  isActive: z.boolean().default(true),
  staffIds: z.array(z.string().uuid()).max(100).default([]),
});

type BusinessPublicDetails = {
  id: string;
  name: string;
  timeZone: string;
  locale: string;
  currency: string;
};

const csrfGuard: RequestHandler = (req, res, next) => {
  if (req.get("x-bookora-request") !== "1") {
    res.status(403).json({ error: "Request verification failed." });
    return;
  }
  next();
};

const requireAuth: RequestHandler = (req, res, next) => {
  const token = req.cookies[SESSION_COOKIE];
  if (typeof token !== "string") {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }

  const session = db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, u.id, u.email, u.name,
              u.role, u.business_id
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hashToken(token), new Date().toISOString()) as
    | {
        session_id: string;
        expires_at: string;
        id: string;
        email: string;
        name: string;
        role: UserRole;
        business_id: string | null;
      }
    | undefined;

  if (!session) {
    clearSessionCookie(res);
    res.status(401).json({ error: "Your session has expired. Sign in again." });
    return;
  }

  req.user = {
    id: session.id,
    email: session.email,
    name: session.name,
    role: session.role,
    businessId: session.business_id,
    sessionId: session.session_id,
    sessionExpiresAt: session.expires_at,
  };
  next();
};

function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: "You do not have permission to do that." });
      return;
    }
    next();
  };
}

function sendValidationError(
  res: Response,
  error: z.ZodError,
): void {
  res.status(400).json({
    error: error.issues[0]?.message ?? "Please check the provided information.",
  });
}

function sessionResponse(user: AuthUser, res: Response) {
  const session = createSession(user.id);
  setSessionCookie(res, session.token);
  return {
    user: findPublicUser(user),
    sessionExpiresAt: session.expiresAt,
  };
}

function getUserById(id: string): AuthUser {
  const user = db
    .prepare(
      `SELECT id, email, password_hash, name, role, business_id
       FROM users WHERE id = ?`,
    )
    .get(id) as AuthUser | undefined;
  if (!user) {
    throw new Error("The newly created account could not be loaded.");
  }
  return user;
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function validLocale(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

function validCurrency(value: string): boolean {
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: value });
    return true;
  } catch {
    return false;
  }
}

function businessIdForRequest(
  req: express.Request,
  res: Response,
): string | undefined {
  if (!req.user?.businessId) {
    res.status(403).json({ error: "This account is not linked to a business." });
    return undefined;
  }
  return req.user.businessId;
}

function validateServiceStaff(
  businessId: string,
  staffIds: string[],
): boolean {
  if (staffIds.length === 0) {
    return true;
  }
  const placeholders = staffIds.map(() => "?").join(", ");
  const result = db
    .prepare(
      `SELECT COUNT(*) AS count FROM users
       WHERE business_id = ? AND role = 'staff' AND id IN (${placeholders})`,
    )
    .get(businessId, ...staffIds) as { count: number };
  return result.count === staffIds.length;
}

function replaceServiceStaff(
  businessId: string,
  serviceId: string,
  staffIds: string[],
): void {
  const createdAt = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO staff_services
     (business_id, staff_user_id, service_id, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  for (const staffId of staffIds) {
    insert.run(businessId, staffId, serviceId, createdAt);
  }
}

function listBusinessServices(businessId: string) {
  const services = db
    .prepare(
      `SELECT id, name, description, duration_minutes AS durationMinutes,
              price_minor AS priceMinor, price_currency AS priceCurrency,
              buffer_minutes AS bufferMinutes,
              category, online_booking AS onlineBooking, is_active AS isActive,
              created_at AS createdAt, updated_at AS updatedAt
       FROM services WHERE business_id = ?
       ORDER BY is_active DESC, name COLLATE NOCASE`,
    )
    .all(businessId) as Array<{
    id: string;
    name: string;
    description: string;
    durationMinutes: number;
    priceMinor: number;
    priceCurrency: string;
    bufferMinutes: number;
    category: string | null;
    onlineBooking: number;
    isActive: number;
    createdAt: string;
    updatedAt: string;
  }>;
  const staffAssignments = db
    .prepare(
      `SELECT ss.service_id AS serviceId, ss.staff_user_id AS staffId
       FROM staff_services ss
       JOIN services s ON s.id = ss.service_id
       WHERE ss.business_id = ? AND s.business_id = ?`,
    )
    .all(businessId, businessId) as Array<{
    serviceId: string;
    staffId: string;
  }>;
  const assignments = new Map<string, string[]>();
  for (const assignment of staffAssignments) {
    const staffIds = assignments.get(assignment.serviceId) ?? [];
    staffIds.push(assignment.staffId);
    assignments.set(assignment.serviceId, staffIds);
  }

  return services.map((service) => ({
    ...service,
    category: service.category ?? "",
    onlineBooking: Boolean(service.onlineBooking),
    isActive: Boolean(service.isActive),
    staffIds: assignments.get(service.id) ?? [],
  }));
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/auth/register", authLimiter, async (req, res, next) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }

  try {
    const { name, email, password } = parsed.data;
    const passwordHash = await hashPassword(password);
    const userId = randomUUID();
    const timestamp = new Date().toISOString();

    const createAccount = db.transaction(() => {
      if (parsed.data.accountType === "owner") {
        const businessId = randomUUID();
        db.prepare(
          `INSERT INTO users (id, email, password_hash, name, role, created_at)
           VALUES (?, ?, ?, ?, 'owner', ?)`,
        ).run(userId, email, passwordHash, name, timestamp);
        db.prepare(
          `INSERT INTO businesses (id, owner_user_id, name, created_at)
           VALUES (?, ?, ?, ?)`,
        ).run(businessId, userId, parsed.data.businessName, timestamp);
        db.prepare("UPDATE users SET business_id = ? WHERE id = ?").run(
          businessId,
          userId,
        );
      } else {
        db.prepare(
          `INSERT INTO users (id, email, password_hash, name, role, created_at)
           VALUES (?, ?, ?, ?, 'customer', ?)`,
        ).run(userId, email, passwordHash, name, timestamp);
      }
    });

    createAccount();
    res.status(201).json(sessionResponse(getUserById(userId), res));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("UNIQUE constraint failed: users.email")
    ) {
      res.status(409).json({ error: "An account with this email already exists." });
      return;
    }
    next(error);
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }

  const user = db
    .prepare(
      `SELECT id, email, password_hash, name, role, business_id
       FROM users WHERE email = ?`,
    )
    .get(parsed.data.email) as AuthUser | undefined;
  const passwordMatches = user
    ? await verifyPassword(parsed.data.password, user.password_hash)
    : (await verifyUnknownAccountPassword(parsed.data.password), false);

  if (!user || !passwordMatches) {
    res.status(401).json({ error: "Email or password is incorrect." });
    return;
  }
  res.json(sessionResponse(user, res));
});

app.post("/api/auth/logout", requireAuth, csrfGuard, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(req.user?.sessionId);
  clearSessionCookie(res);
  res.status(204).end();
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  const user = db
    .prepare(
      `SELECT id, email, password_hash, name, role, business_id
       FROM users WHERE id = ?`,
    )
    .get(req.user?.id) as AuthUser | undefined;
  if (!user) {
    res.status(401).json({ error: "Your account is no longer available." });
    return;
  }
  res.json({
    user: findPublicUser(user),
    sessionExpiresAt: req.user?.sessionExpiresAt,
  });
});

app.post("/api/auth/forgot-password", authLimiter, async (req, res, next) => {
  const parsed = resetRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }

  try {
    await verifyEmailDelivery();
    const user = db
      .prepare("SELECT id, email FROM users WHERE email = ?")
      .get(parsed.data.email) as { id: string; email: string } | undefined;

    if (user) {
      const token = createOpaqueToken();
      const tokenId = randomUUID();
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + 30 * 60 * 1000);
      db.prepare(
        `INSERT INTO password_reset_tokens
         (id, user_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        tokenId,
        user.id,
        hashToken(token),
        expiresAt.toISOString(),
        createdAt.toISOString(),
      );

      try {
        await sendAccountEmail(
          user.email,
          "Reset your Bookora password",
          `Use this link within 30 minutes to set a new password:\n\n${appOrigin}/reset-password?token=${encodeURIComponent(token)}\n\nIf you did not request this, you can ignore this message.`,
        );
      } catch (error) {
        db.prepare("DELETE FROM password_reset_tokens WHERE id = ?").run(tokenId);
        next(error);
        return;
      }
    }

    res.json({
      message: "If an account exists for that email, a reset link has been sent.",
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/reset-password", authLimiter, async (req, res, next) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }

  try {
    const passwordHash = await hashPassword(parsed.data.password);
    const now = new Date().toISOString();
    const reset = db.transaction(() => {
      const token = db
        .prepare(
          `SELECT id, user_id FROM password_reset_tokens
           WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
        )
        .get(hashToken(parsed.data.token), now) as
        | { id: string; user_id: string }
        | undefined;
      if (!token) {
        return false;
      }
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
        passwordHash,
        token.user_id,
      );
      db.prepare(
        "UPDATE password_reset_tokens SET consumed_at = ? WHERE id = ?",
      ).run(now, token.id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(token.user_id);
      return true;
    });

    if (!reset()) {
      res.status(400).json({ error: "This reset link is invalid or has expired." });
      return;
    }
    res.json({ message: "Your password has been updated. You can now sign in." });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/business/staff-invitations",
  requireAuth,
  csrfGuard,
  requireRole("owner"),
  async (req, res, next) => {
    const parsed = invitationSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }

    try {
      const email = parsed.data.email;
      const existingUser = db
        .prepare("SELECT id FROM users WHERE email = ?")
        .get(email);
      if (existingUser) {
        res.status(409).json({ error: "An account with this email already exists." });
        return;
      }

      const token = createOpaqueToken();
      const invitationId = randomUUID();
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000);
      db.prepare(
        `INSERT INTO staff_invitations
         (id, business_id, email, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        invitationId,
        req.user?.businessId,
        email,
        hashToken(token),
        expiresAt.toISOString(),
        createdAt.toISOString(),
      );

      try {
        await sendAccountEmail(
          email,
          "You're invited to join a Bookora business",
          `Create your staff account within seven days:\n\n${appOrigin}/accept-invitation?token=${encodeURIComponent(token)}\n`,
        );
      } catch (error) {
        db.prepare("DELETE FROM staff_invitations WHERE id = ?").run(
          invitationId,
        );
        next(error);
        return;
      }

      res.status(202).json({ message: `Invitation sent to ${email}.` });
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  "/api/auth/accept-invitation",
  authLimiter,
  async (req, res, next) => {
    const parsed = acceptInvitationSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }

    try {
      const passwordHash = await hashPassword(parsed.data.password);
      const userId = randomUUID();
      const now = new Date().toISOString();
      const createStaff = db.transaction(() => {
        const invitation = db
          .prepare(
            `SELECT id, business_id, email FROM staff_invitations
             WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?`,
          )
          .get(hashToken(parsed.data.token), now) as
          | { id: string; business_id: string; email: string }
          | undefined;
        if (!invitation) {
          return false;
        }

        db.prepare(
          `INSERT INTO users
           (id, email, password_hash, name, role, business_id, created_at)
           VALUES (?, ?, ?, ?, 'staff', ?, ?)`,
        ).run(
          userId,
          invitation.email,
          passwordHash,
          parsed.data.name,
          invitation.business_id,
          now,
        );
        db.prepare(
          "UPDATE staff_invitations SET accepted_at = ? WHERE id = ?",
        ).run(now, invitation.id);
        return true;
      });

      if (!createStaff()) {
        res.status(400).json({
          error: "This invitation is invalid, expired, or already used.",
        });
        return;
      }

      res.status(201).json(sessionResponse(getUserById(userId), res));
    } catch (error) {
      next(error);
    }
  },
);

app.get(
  "/api/business",
  requireAuth,
  requireRole("owner", "staff"),
  (req, res) => {
    const businessId = businessIdForRequest(req, res);
    if (!businessId) {
      return;
    }

    const business = db
      .prepare(
        `SELECT id, name, time_zone AS timeZone, locale, currency
         FROM businesses WHERE id = ?`,
      )
      .get(businessId) as
      | {
          id: string;
          name: string;
          timeZone: string;
          locale: string;
          currency: string;
        }
      | undefined;
    if (!business) {
      res.status(404).json({ error: "Business not found." });
      return;
    }
    res.json({ business });
  },
);

app.put(
  "/api/business/settings",
  requireAuth,
  csrfGuard,
  requireRole("owner"),
  (req, res) => {
    const parsed = businessSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }

    const { name, timeZone, locale, currency } = parsed.data;
    if (!validTimeZone(timeZone)) {
      res.status(400).json({ error: "Choose a valid IANA time zone." });
      return;
    }
    if (!validLocale(locale)) {
      res.status(400).json({ error: "Choose a valid locale." });
      return;
    }
    if (!validCurrency(currency)) {
      res.status(400).json({ error: "Choose a valid three-letter currency code." });
      return;
    }
    const businessId = businessIdForRequest(req, res);
    if (!businessId) {
      return;
    }

    const result = db
      .prepare(
        `UPDATE businesses
         SET name = ?, time_zone = ?, locale = ?, currency = ?
         WHERE id = ?`,
      )
      .run(name, timeZone, locale, currency, businessId);
    if (result.changes === 0) {
      res.status(404).json({ error: "Business not found." });
      return;
    }
    res.json({
      business: { id: businessId, name, timeZone, locale, currency },
    });
  },
);

app.get(
  "/api/business/staff",
  requireAuth,
  requireRole("owner"),
  (req, res) => {
    const businessId = businessIdForRequest(req, res);
    if (!businessId) {
      return;
    }
    const staff = db
      .prepare(
        `SELECT id, name, email FROM users
         WHERE business_id = ? AND role = 'staff'
         ORDER BY name COLLATE NOCASE`,
      )
      .all(businessId) as Array<{ id: string; name: string; email: string }>;
    res.json({ staff });
  },
);

app.get(
  "/api/business/services",
  requireAuth,
  requireRole("owner", "staff"),
  (req, res) => {
    const businessId = businessIdForRequest(req, res);
    if (!businessId) {
      return;
    }
    res.json({ services: listBusinessServices(businessId) });
  },
);

app.post(
  "/api/business/services",
  requireAuth,
  csrfGuard,
  requireRole("owner"),
  (req, res) => {
    const parsed = serviceSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }

    const businessId = businessIdForRequest(req, res);
    if (!businessId) {
      return;
    }
    const { staffIds, ...service } = parsed.data;
    if (!validateServiceStaff(businessId, staffIds)) {
      res.status(400).json({
        error: "Select team members who belong to this business.",
      });
      return;
    }
    if (!validCurrency(service.priceCurrency)) {
      res.status(400).json({ error: "Choose a valid currency for this service." });
      return;
    }

    const serviceId = randomUUID();
    const timestamp = new Date().toISOString();
    const createService = db.transaction(() => {
      db.prepare(
        `INSERT INTO services
         (id, business_id, name, description, duration_minutes, price_minor,
          price_currency, buffer_minutes, category, online_booking, is_active,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        serviceId,
        businessId,
        service.name,
        service.description,
        service.durationMinutes,
        service.priceMinor,
        service.priceCurrency,
        service.bufferMinutes,
        service.category || null,
        Number(service.onlineBooking),
        Number(service.isActive),
        timestamp,
        timestamp,
      );
      replaceServiceStaff(businessId, serviceId, staffIds);
    });
    createService();
    res.status(201).json({
      service: listBusinessServices(businessId).find(
        (entry) => entry.id === serviceId,
      ),
    });
  },
);

app.put(
  "/api/business/services/:id",
  requireAuth,
  csrfGuard,
  requireRole("owner"),
  (req, res) => {
    const parsed = serviceSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    const businessId = businessIdForRequest(req, res);
    if (!businessId) {
      return;
    }
    const parsedId = z.uuid().safeParse(req.params.id);
    if (!parsedId.success) {
      res.status(404).json({ error: "Service not found." });
      return;
    }
    const serviceId = parsedId.data;
    const existing = db
      .prepare("SELECT id FROM services WHERE id = ? AND business_id = ?")
      .get(serviceId, businessId);
    if (!existing) {
      res.status(404).json({ error: "Service not found." });
      return;
    }

    const { staffIds, ...service } = parsed.data;
    if (!validateServiceStaff(businessId, staffIds)) {
      res.status(400).json({
        error: "Select team members who belong to this business.",
      });
      return;
    }
    if (!validCurrency(service.priceCurrency)) {
      res.status(400).json({ error: "Choose a valid currency for this service." });
      return;
    }
    const timestamp = new Date().toISOString();
    const updateService = db.transaction(() => {
      db.prepare(
        `UPDATE services
         SET name = ?, description = ?, duration_minutes = ?, price_minor = ?,
             price_currency = ?, buffer_minutes = ?, category = ?,
             online_booking = ?, is_active = ?, updated_at = ?
         WHERE id = ? AND business_id = ?`,
      ).run(
        service.name,
        service.description,
        service.durationMinutes,
        service.priceMinor,
        service.priceCurrency,
        service.bufferMinutes,
        service.category || null,
        Number(service.onlineBooking),
        Number(service.isActive),
        timestamp,
        serviceId,
        businessId,
      );
      db.prepare(
        "DELETE FROM staff_services WHERE service_id = ? AND business_id = ?",
      ).run(serviceId, businessId);
      replaceServiceStaff(businessId, serviceId, staffIds);
    });
    updateService();
    res.json({
      service: listBusinessServices(businessId).find(
        (entry) => entry.id === serviceId,
      ),
    });
  },
);

app.delete(
  "/api/business/services/:id",
  requireAuth,
  csrfGuard,
  requireRole("owner"),
  (req, res) => {
    const businessId = businessIdForRequest(req, res);
    if (!businessId) {
      return;
    }
    const parsedId = z.uuid().safeParse(req.params.id);
    if (!parsedId.success) {
      res.status(404).json({ error: "Active service not found." });
      return;
    }
    const result = db
      .prepare(
        `UPDATE services SET is_active = 0, updated_at = ?
         WHERE id = ? AND business_id = ?`,
      )
      .run(new Date().toISOString(), parsedId.data, businessId);
    if (result.changes === 0) {
      res.status(404).json({ error: "Service not found." });
      return;
    }
    res.status(204).end();
  },
);

app.get("/api/public/businesses/:businessId/services", (req, res) => {
  const parsedId = z.uuid().safeParse(req.params.businessId);
  if (!parsedId.success) {
    res.status(404).json({ error: "Business not found." });
    return;
  }
  const business = db
    .prepare(
      `SELECT id, name, time_zone AS timeZone, locale, currency
       FROM businesses WHERE id = ?`,
    )
    .get(parsedId.data) as BusinessPublicDetails | undefined;
  if (!business) {
    res.status(404).json({ error: "Business not found." });
    return;
  }
  const services = db
    .prepare(
      `SELECT id, name, description, duration_minutes AS durationMinutes,
              price_minor AS priceMinor, price_currency AS priceCurrency,
              buffer_minutes AS bufferMinutes, category
       FROM services
       WHERE business_id = ? AND is_active = 1 AND online_booking = 1
         AND EXISTS (
           SELECT 1 FROM staff_services
           WHERE staff_services.business_id = services.business_id
             AND staff_services.service_id = services.id
         )
       ORDER BY category COLLATE NOCASE, name COLLATE NOCASE`,
    )
    .all(business.id);
  res.json({ business, services });
});

const clientBuild = path.resolve("dist/client");
if (existsSync(clientBuild)) {
  app.use(express.static(clientBuild));
  app.get("/{*path}", (req, res, next) => {
    if (req.path.startsWith("/api/")) {
      next();
      return;
    }
    res.sendFile(path.join(clientBuild, "index.html"));
  });
}

app.use((_req, res) => {
  res.status(404).json({ error: "That resource was not found." });
});

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof MailConfigurationError) {
    res.status(503).json({ error: error.message });
    return;
  }
  console.error(
    "Request failed:",
    error instanceof Error ? error.name : "UnknownError",
  );
  res.status(500).json({ error: "Something went wrong. Please try again." });
};
app.use(errorHandler);

const host = process.env.HOST ?? "127.0.0.1";
app.listen(port, host, () => {
  console.log(`Bookora API listening on http://${host}:${port}`);
});
