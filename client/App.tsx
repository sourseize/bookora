import { useCallback, useEffect, useState, type FormEvent } from "react";

type User = {
  id: string;
  email: string;
  name: string;
  role: "owner" | "staff" | "customer";
  businessId: string | null;
  businessName: string | null;
};

type AuthResponse = {
  user: User;
  sessionExpiresAt: string;
};

type Business = {
  id: string;
  name: string;
  timeZone: string;
  locale: string;
  currency: string;
};

type StaffMember = {
  id: string;
  name: string;
  email: string;
};

type CatalogService = {
  id: string;
  name: string;
  description: string;
  durationMinutes: number;
  priceMinor: number;
  priceCurrency: string;
  bufferMinutes: number;
  category: string;
  onlineBooking: boolean;
  isActive: boolean;
  staffIds: string[];
};

type Screen = "login" | "register" | "forgot" | "reset" | "invite";
type AccountType = "owner" | "customer";

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const mutating = options.method && options.method !== "GET";
  const headers = new Headers(options.headers);
  if (options.body) {
    headers.set("Content-Type", "application/json");
  }
  if (mutating) {
    headers.set("x-bookora-request", "1");
  }

  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  if (response.status === 204) {
    return undefined as T;
  }

  const result: unknown = await response.json();
  if (!response.ok) {
    const message =
      typeof result === "object" &&
      result !== null &&
      "error" in result &&
      typeof result.error === "string"
        ? result.error
        : "The request could not be completed.";
    throw new ApiError(message, response.status);
  }
  return result as T;
}

function readTokenFromUrl(): string {
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [screen, setScreen] = useState<Screen>(() => {
    const path = window.location.pathname;
    if (path === "/reset-password") return "reset";
    if (path === "/accept-invitation") return "invite";
    return "login";
  });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const refreshSession = useCallback(async () => {
    try {
      const session = await api<AuthResponse>("/api/auth/me");
      setUser(session.user);
    } catch (error) {
      setUser(null);
      if (!(error instanceof ApiError && error.status === 401)) {
        setMessage(
          error instanceof Error ? error.message : "Unable to connect to Bookora.",
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  function navigate(next: Screen) {
    setMessage("");
    setScreen(next);
    const path =
      next === "reset"
        ? "/reset-password"
        : next === "invite"
          ? "/accept-invitation"
          : "/";
    const query = next === "reset" || next === "invite" ? window.location.search : "";
    window.history.replaceState({}, "", `${path}${query}`);
  }

  async function submit(
    event: FormEvent<HTMLFormElement>,
    endpoint: string,
    values: Record<string, string>,
    onSuccess: (result: unknown) => void,
  ) {
    event.preventDefault();
    setMessage("");
    const formData = new FormData(event.currentTarget);
    const body = Object.fromEntries(
      Object.entries(values).map(([key, fieldName]) => [
        key,
        formData.get(fieldName)?.toString() ?? "",
      ]),
    );

    try {
      const result = await api<unknown>(endpoint, {
        method: "POST",
        body: JSON.stringify(body),
      });
      onSuccess(result);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "The request could not be completed.",
      );
    }
  }

  async function logout() {
    try {
      await api<void>("/api/auth/logout", { method: "POST" });
      setUser(null);
      setMessage("");
      navigate("login");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to sign out right now.",
      );
    }
  }

  if (loading) {
    return (
      <main className="loading-screen" aria-live="polite">
        <div className="brand-mark">b</div>
        <p>Getting your space ready...</p>
      </main>
    );
  }

  if (user) {
    return (
      <Dashboard
        user={user}
        message={message}
        onDismissMessage={() => setMessage("")}
        onLogout={() => void logout()}
        onInvite={(event, email) =>
          void submit(
            event,
            "/api/business/staff-invitations",
            { email: "email" },
            (result) => {
              const response = result as { message: string };
              setMessage(response.message);
              email.reset();
            },
          )
        }
      />
    );
  }

  return (
    <AuthLayout>
      {screen === "register" ? (
        <RegisterForm
          message={message}
          onSubmit={(event) =>
            void submit(
              event,
              "/api/auth/register",
              {
                accountType: "accountType",
                name: "name",
                email: "email",
                password: "password",
                businessName: "businessName",
              },
              (result) => {
                const session = result as AuthResponse;
                setUser(session.user);
              },
            )
          }
          onLogin={() => navigate("login")}
        />
      ) : screen === "forgot" ? (
        <ForgotForm
          message={message}
          onSubmit={(event) =>
            void submit(
              event,
              "/api/auth/forgot-password",
              { email: "email" },
              (result) => setMessage((result as { message: string }).message),
            )
          }
          onBack={() => navigate("login")}
        />
      ) : screen === "reset" ? (
        <PasswordForm
          title="Choose a new password"
          description="Use at least 12 characters to keep your account protected."
          submitLabel="Update password"
          message={message}
          onSubmit={(event) =>
            void submit(
              event,
              "/api/auth/reset-password",
              { token: "token", password: "password" },
              (result) => {
                setMessage((result as { message: string }).message);
                window.history.replaceState({}, "", "/");
                setScreen("login");
              },
            )
          }
          hiddenToken={readTokenFromUrl()}
          onBack={() => navigate("login")}
        />
      ) : screen === "invite" ? (
        <PasswordForm
          title="Join your team"
          description="Create your staff account to access your business workspace."
          submitLabel="Accept invitation"
          message={message}
          invite
          onSubmit={(event) =>
            void submit(
              event,
              "/api/auth/accept-invitation",
              {
                token: "token",
                name: "name",
                password: "password",
              },
              (result) => {
                const session = result as AuthResponse;
                setUser(session.user);
                window.history.replaceState({}, "", "/");
              },
            )
          }
          hiddenToken={readTokenFromUrl()}
          onBack={() => navigate("login")}
        />
      ) : (
        <LoginForm
          message={message}
          onSubmit={(event) =>
            void submit(
              event,
              "/api/auth/login",
              { email: "email", password: "password" },
              (result) => setUser((result as AuthResponse).user),
            )
          }
          onRegister={() => navigate("register")}
          onForgot={() => navigate("forgot")}
        />
      )}
    </AuthLayout>
  );
}

function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth-page">
      <section className="brand-panel">
        <div className="brand-lockup">
          <div className="brand-mark">b</div>
          <span>bookora</span>
        </div>
        <div className="brand-copy">
          <span className="eyebrow">A little more room to breathe</span>
          <h1>Your business.<br />Your time.</h1>
          <p>All the moving parts, coming together beautifully.</p>
        </div>
        <div className="brand-note">
          <span className="note-spark">✳</span>
          <span>Make space for the work you love.</span>
        </div>
        <div className="decor-orbit orbit-one" />
        <div className="decor-orbit orbit-two" />
      </section>
      <section className="form-panel">
        <div className="mobile-brand">
          <div className="brand-mark">b</div>
          <span>bookora</span>
        </div>
        <div className="auth-card">{children}</div>
        <p className="form-footer">Thoughtfully made for businesses like yours.</p>
      </section>
    </main>
  );
}

function Alert({ message }: { message: string }) {
  return message ? (
    <div className="alert" role="alert">
      <span className="alert-icon">!</span>
      <span>{message}</span>
    </div>
  ) : null;
}

function currencyDigits(currency: string, locale: string): number {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).resolvedOptions().maximumFractionDigits ?? 2;
}

function minorToAmount(amount: number, currency: string, locale: string): string {
  const digits = currencyDigits(currency, locale);
  return (amount / 10 ** digits).toFixed(digits);
}

function BusinessWorkspace() {
  const [business, setBusiness] = useState<Business | null>(null);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [services, setServices] = useState<CatalogService[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<"new" | CatalogService | null>(null);

  const loadWorkspace = useCallback(async () => {
    setError("");
    try {
      const [businessResponse, staffResponse, serviceResponse] =
        await Promise.all([
          api<{ business: Business }>("/api/business"),
          api<{ staff: StaffMember[] }>("/api/business/staff"),
          api<{ services: CatalogService[] }>("/api/business/services"),
        ]);
      setBusiness(businessResponse.business);
      setStaff(staffResponse.staff);
      setServices(serviceResponse.services);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load your business catalogue.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  async function saveBusiness(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!business) return;
    setError("");
    setNotice("");
    const formData = new FormData(event.currentTarget);
    try {
      const response = await api<{ business: Business }>(
        "/api/business/settings",
        {
          method: "PUT",
          body: JSON.stringify({
            name: formData.get("businessName"),
            timeZone: formData.get("timeZone"),
            locale: formData.get("locale"),
            currency: formData.get("currency"),
          }),
        },
      );
      setBusiness(response.business);
      setNotice("Business settings saved.");
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to save business settings.",
      );
    }
  }

  async function saveService(
    event: FormEvent<HTMLFormElement>,
    serviceId?: string,
  ) {
    event.preventDefault();
    if (!business) return;
    setError("");
    setNotice("");

    const formData = new FormData(event.currentTarget);
    const amount = Number(formData.get("price"));
    const priceCurrency = String(formData.get("priceCurrency"));
    const factor = 10 ** currencyDigits(priceCurrency, business.locale);
    const payload = {
      name: formData.get("name"),
      description: formData.get("description"),
      durationMinutes: Number(formData.get("durationMinutes")),
      priceMinor: Math.round(amount * factor),
      priceCurrency,
      bufferMinutes: Number(formData.get("bufferMinutes")),
      category: formData.get("category"),
      onlineBooking: formData.get("onlineBooking") === "on",
      isActive: formData.get("isActive") === "on",
      staffIds: formData.getAll("staffIds").map(String),
    };

    try {
      await api<{ service: CatalogService }>(
        serviceId
          ? `/api/business/services/${encodeURIComponent(serviceId)}`
          : "/api/business/services",
        {
          method: serviceId ? "PUT" : "POST",
          body: JSON.stringify(payload),
        },
      );
      setNotice(serviceId ? "Service updated." : "Service added.");
      setEditor(null);
      await loadWorkspace();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Unable to save service.",
      );
    }
  }

  async function deactivateService(service: CatalogService) {
    if (!window.confirm(`Deactivate “${service.name}”? It will remain in your catalogue but won't be available for new online bookings.`)) {
      return;
    }
    setError("");
    setNotice("");
    try {
      await api<void>(
        `/api/business/services/${encodeURIComponent(service.id)}`,
        { method: "DELETE" },
      );
      setNotice(`${service.name} was deactivated.`);
      await loadWorkspace();
    } catch (deactivateError) {
      setError(
        deactivateError instanceof Error
          ? deactivateError.message
          : "Unable to deactivate this service.",
      );
    }
  }

  if (loading) {
    return (
      <section className="workspace-loading" aria-live="polite">
        Loading your business catalogue...
      </section>
    );
  }

  if (!business) {
    return <Alert message={error || "Your business settings are unavailable."} />;
  }

  return (
    <div className="business-workspace">
      {error && <Alert message={error} />}
      {notice && <p className="success-note" role="status">{notice}</p>}

      <section className="workspace-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">The essentials</span>
            <h2>Business settings</h2>
          </div>
        </div>
        <form className="business-settings-form" onSubmit={(event) => void saveBusiness(event)}>
          <label>
            Business name
            <input name="businessName" defaultValue={business.name} required minLength={2} maxLength={100} />
          </label>
          <label>
            Time zone
            <input name="timeZone" defaultValue={business.timeZone} required maxLength={100} placeholder="America/Toronto" />
            <span className="field-hint">Use an IANA time zone, such as America/Toronto.</span>
          </label>
          <label>
            Currency
            <input name="currency" defaultValue={business.currency} required minLength={3} maxLength={3} pattern="[A-Za-z]{3}" />
            <span className="field-hint">Three-letter currency code, for example CAD or USD.</span>
          </label>
          <label>
            Locale
            <input name="locale" defaultValue={business.locale} required maxLength={40} placeholder="en-CA" />
            <span className="field-hint">Controls currency formatting, e.g. en-CA.</span>
          </label>
          <button className="primary-button settings-submit" type="submit">Save settings <span>→</span></button>
        </form>
      </section>

      <section className="workspace-section catalogue-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">What you offer</span>
            <h2>Your services <span className="item-count">{services.length}</span></h2>
          </div>
          {!editor && (
            <button className="primary-button add-service-button" onClick={() => setEditor("new")}>
              <span aria-hidden="true">+</span> Add a service
            </button>
          )}
        </div>
        {editor && (
          <ServiceEditor
            key={editor === "new" ? "new" : editor.id}
            service={editor === "new" ? undefined : editor}
            staff={staff}
            business={business}
            onCancel={() => setEditor(null)}
            onSubmit={(event) =>
              void saveService(
                event,
                editor === "new" ? undefined : editor.id,
              )
            }
          />
        )}
        {services.length === 0 && !editor ? (
          <div className="empty-catalogue">
            <span className="empty-spark">✳</span>
            <h3>A good place to begin.</h3>
            <p>Add your first service with its duration, price, and booking details.</p>
            <button className="text-button" onClick={() => setEditor("new")}>Add your first service →</button>
          </div>
        ) : (
          <div className="service-list">
            {services.map((service) => (
              <article
                className={`service-row${service.isActive ? "" : " service-row-inactive"}`}
                key={service.id}
              >
                <div className="service-detail">
                  <div className="service-title-line">
                    <h3>{service.name}</h3>
                    {!service.isActive && <span className="inactive-pill">Inactive</span>}
                    {service.category && <span className="category-pill">{service.category}</span>}
                  </div>
                  {service.description && <p>{service.description}</p>}
                  <div className="service-meta">
                    <span>{service.durationMinutes} min</span>
                    {service.bufferMinutes > 0 && <span>{service.bufferMinutes} min buffer</span>}
                    <span>{service.onlineBooking ? "Online booking on" : "Online booking off"}</span>
                    <span>{service.staffIds.length ? `${service.staffIds.length} team member${service.staffIds.length === 1 ? "" : "s"}` : "No team members assigned"}</span>
                  </div>
                </div>
                <div className="service-actions">
                  <strong>
                    {new Intl.NumberFormat(business.locale, {
                      style: "currency",
                      currency: service.priceCurrency,
                    }).format(service.priceMinor / 10 ** currencyDigits(service.priceCurrency, business.locale))}
                  </strong>
                  <button className="text-button" onClick={() => setEditor(service)}>Edit</button>
                  {service.isActive && (
                    <button className="text-button deactivate-button" onClick={() => void deactivateService(service)}>
                      Deactivate
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ServiceEditor({
  service,
  staff,
  business,
  onCancel,
  onSubmit,
}: {
  service?: CatalogService;
  staff: StaffMember[];
  business: Business;
  onCancel: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [selectedStaff, setSelectedStaff] = useState(service?.staffIds ?? []);
  const [priceCurrency, setPriceCurrency] = useState(
    service?.priceCurrency ?? business.currency,
  );
  const digits = currencyDigits(priceCurrency, business.locale);
  const priceStep = digits === 0 ? "1" : `0.${"0".repeat(digits - 1)}1`;
  const currencies = [
    ...new Set([
      business.currency,
      service?.priceCurrency ?? "",
      "USD",
      "CAD",
      "EUR",
      "GBP",
      "AUD",
      "NZD",
      "JPY",
      "CHF",
      "INR",
    ]),
  ].filter(Boolean);

  function toggleStaff(staffId: string) {
    setSelectedStaff((current) =>
      current.includes(staffId)
        ? current.filter((id) => id !== staffId)
        : [...current, staffId],
    );
  }

  return (
    <form className="service-editor" onSubmit={onSubmit}>
      <div className="editor-heading">
        <h3>{service ? "Edit service" : "Add a service"}</h3>
        <button className="text-button" type="button" onClick={onCancel}>Cancel</button>
      </div>
      <div className="editor-grid">
        <label className="editor-wide">
          Service name
          <input name="name" defaultValue={service?.name} required minLength={2} maxLength={100} placeholder="e.g. Signature haircut" />
        </label>
        <label className="editor-wide">
          Description
          <textarea name="description" defaultValue={service?.description} maxLength={1000} rows={2} placeholder="A short description customers can use to choose the right service." />
        </label>
        <label>
          Duration (minutes)
          <input name="durationMinutes" type="number" defaultValue={service?.durationMinutes ?? 30} min={5} max={1440} step={5} required />
        </label>
        <label>
          Price
          <input name="price" type="number" defaultValue={service ? minorToAmount(service.priceMinor, service.priceCurrency, business.locale) : ""} min={0} max={1_000_000_000 / 10 ** digits} step={priceStep} required placeholder={minorToAmount(0, priceCurrency, business.locale)} />
        </label>
        <label>
          Price currency
          <select name="priceCurrency" value={priceCurrency} onChange={(event) => setPriceCurrency(event.target.value)}>
            {currencies.map((currency) => <option value={currency} key={currency}>{currency}</option>)}
          </select>
        </label>
        <label>
          Buffer after service (minutes)
          <input name="bufferMinutes" type="number" defaultValue={service?.bufferMinutes ?? 0} min={0} max={240} step={5} />
        </label>
        <label>
          Category
          <input name="category" defaultValue={service?.category} maxLength={60} placeholder="Hair, wellness, consultation..." />
        </label>
      </div>
      <fieldset className="staff-assignment">
        <legend>Team members who can provide this service</legend>
        {staff.length === 0 ? (
          <p>Invite a team member first; you can assign services to them here.</p>
        ) : (
          <div className="staff-choice-list">
            {staff.map((member) => (
              <label className="staff-choice" key={member.id}>
                <input
                  type="checkbox"
                  name="staffIds"
                  value={member.id}
                  checked={selectedStaff.includes(member.id)}
                  onChange={() => toggleStaff(member.id)}
                />
                <span><strong>{member.name}</strong><small>{member.email}</small></span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <div className="service-toggles">
        <label><input type="checkbox" name="onlineBooking" defaultChecked={service?.onlineBooking ?? true} /> Available for online booking</label>
        <label><input type="checkbox" name="isActive" defaultChecked={service?.isActive ?? true} /> Active in the catalogue</label>
      </div>
      <div className="editor-actions">
        <button className="primary-button" type="submit">{service ? "Save changes" : "Add service"} <span>→</span></button>
      </div>
    </form>
  );
}

function LoginForm({
  message,
  onSubmit,
  onRegister,
  onForgot,
}: {
  message: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onRegister: () => void;
  onForgot: () => void;
}) {
  return (
    <>
      <span className="eyebrow">Welcome back</span>
      <h2>Sign in to your space</h2>
      <p className="form-intro">Pick up right where you left off.</p>
      <Alert message={message} />
      <form className="form-stack" onSubmit={onSubmit}>
        <label>
          Email address
          <input name="email" type="email" autoComplete="email" required maxLength={254} />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
          />
        </label>
        <button className="text-button forgot-link" type="button" onClick={onForgot}>
          Forgot password?
        </button>
        <button className="primary-button" type="submit">
          Sign in <span aria-hidden="true">→</span>
        </button>
      </form>
      <p className="form-switch">
        New to Bookora? <button className="text-button" onClick={onRegister}>Create an account</button>
      </p>
    </>
  );
}

function RegisterForm({
  message,
  onSubmit,
  onLogin,
}: {
  message: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onLogin: () => void;
}) {
  const [accountType, setAccountType] = useState<AccountType>("owner");

  return (
    <>
      <span className="eyebrow">A fresh start</span>
      <h2>Create your account</h2>
      <p className="form-intro">A calmer way to run your day starts here.</p>
      <Alert message={message} />
      <form className="form-stack" onSubmit={onSubmit}>
        <label>
          I’m here as
          <select
            name="accountType"
            value={accountType}
            onChange={(event) => setAccountType(event.target.value as AccountType)}
          >
            <option value="owner">A business owner</option>
            <option value="customer">A customer</option>
          </select>
        </label>
        {accountType === "owner" && (
          <label>
            Business name
            <input name="businessName" autoComplete="organization" required maxLength={100} />
          </label>
        )}
        <label>
          Your name
          <input name="name" autoComplete="name" required minLength={2} maxLength={80} />
        </label>
        <label>
          Email address
          <input name="email" type="email" autoComplete="email" required maxLength={254} />
        </label>
        <label>
          Create a password
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            aria-describedby="password-hint"
          />
          <span className="field-hint" id="password-hint">At least 12 characters.</span>
        </label>
        <button className="primary-button" type="submit">
          Create account <span aria-hidden="true">→</span>
        </button>
      </form>
      <p className="form-switch">
        Already have an account? <button className="text-button" onClick={onLogin}>Sign in</button>
      </p>
    </>
  );
}

function ForgotForm({
  message,
  onSubmit,
  onBack,
}: {
  message: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
}) {
  return (
    <>
      <span className="eyebrow">Account recovery</span>
      <h2>Let’s get you back in</h2>
      <p className="form-intro">We’ll email a secure link if an account matches.</p>
      <Alert message={message} />
      <form className="form-stack" onSubmit={onSubmit}>
        <label>
          Email address
          <input name="email" type="email" autoComplete="email" required maxLength={254} />
        </label>
        <button className="primary-button" type="submit">Send reset link <span>→</span></button>
      </form>
      <p className="form-switch">
        <button className="text-button" onClick={onBack}>← Back to sign in</button>
      </p>
    </>
  );
}

function PasswordForm({
  title,
  description,
  submitLabel,
  message,
  onSubmit,
  hiddenToken,
  onBack,
  invite = false,
}: {
  title: string;
  description: string;
  submitLabel: string;
  message: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  hiddenToken: string;
  onBack: () => void;
  invite?: boolean;
}) {
  return (
    <>
      <span className="eyebrow">{invite ? "Team invitation" : "Account recovery"}</span>
      <h2>{title}</h2>
      <p className="form-intro">{description}</p>
      <Alert message={message} />
      <form className="form-stack" onSubmit={onSubmit}>
        {invite && (
          <label>
            Your name
            <input name="name" autoComplete="name" required minLength={2} maxLength={80} />
          </label>
        )}
        <input type="hidden" name="token" value={hiddenToken} />
        <label>
          New password
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
          />
        </label>
        <button className="primary-button" type="submit">
          {submitLabel} <span aria-hidden="true">→</span>
        </button>
      </form>
      <p className="form-switch">
        <button className="text-button" onClick={onBack}>← Back to sign in</button>
      </p>
    </>
  );
}

function Dashboard({
  user,
  message,
  onDismissMessage,
  onLogout,
  onInvite,
}: {
  user: User;
  message: string;
  onDismissMessage: () => void;
  onLogout: () => void;
  onInvite: (
    event: FormEvent<HTMLFormElement>,
    form: HTMLFormElement,
  ) => void;
}) {
  const roleLabel = {
    owner: "Business owner",
    staff: "Team member",
    customer: "Customer",
  }[user.role];

  return (
    <main className="dashboard-page">
      <header className="dashboard-header">
        <a className="brand-lockup dark" href="/" aria-label="Bookora home">
          <div className="brand-mark">b</div>
          <span>bookora</span>
        </a>
        <div className="header-actions">
          <span className="role-pill">{roleLabel}</span>
          <button className="logout-button" onClick={onLogout}>Sign out</button>
        </div>
      </header>
      <div className="dashboard-content">
        <span className="eyebrow">Your Bookora space</span>
        <h1>Good to have you here, {user.name.split(" ")[0]}.</h1>
        <p className="dashboard-intro">
          Your account is ready. This is your home base for the things that keep your day flowing.
        </p>
        <Alert message={message} />
        {message && (
          <button className="text-button dismiss-message" onClick={onDismissMessage}>
            Dismiss
          </button>
        )}
        <section className="account-grid" aria-label="Account details">
          <article className="account-card account-card-primary">
            <span className="card-icon">✳</span>
            <span className="card-label">Your role</span>
            <strong>{roleLabel}</strong>
            <p>{user.role === "owner" ? "You’re in charge of this business space." : "Your Bookora account is all set."}</p>
          </article>
          <article className="account-card">
            <span className="card-label">Signed in as</span>
            <strong className="account-value">{user.email}</strong>
            <p>Your account details are securely stored.</p>
          </article>
          {user.businessName && (
            <article className="account-card">
              <span className="card-label">Your business</span>
              <strong className="account-value">{user.businessName}</strong>
              <p>Your team workspace is ready to grow.</p>
            </article>
          )}
        </section>
        {user.role === "owner" && (
          <>
            <section className="invite-panel">
              <div>
                <span className="eyebrow">Growing a team?</span>
                <h2>Bring your people along.</h2>
                <p>Send a secure invitation so a teammate can join your business workspace.</p>
              </div>
              <form
                className="invite-form"
                onSubmit={(event) =>
                  onInvite(event, event.currentTarget)
                }
              >
                <label htmlFor="staff-email">Team member’s email</label>
                <div className="invite-controls">
                  <input
                    id="staff-email"
                    name="email"
                    type="email"
                    required
                    maxLength={254}
                    placeholder="teammate@example.com"
                  />
                  <button className="primary-button" type="submit">Send invite <span>→</span></button>
                </div>
              </form>
            </section>
            <BusinessWorkspace />
          </>
        )}
      </div>
      <footer className="dashboard-footer">
        <span>Bookora</span>
        <span>Your business. Your time. Beautifully organised.</span>
      </footer>
    </main>
  );
}

export default App;
