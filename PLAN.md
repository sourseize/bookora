# Bookora Implementation Plan

## Product vision

Bookora is a polished appointment-booking and business-management product for small service businesses. Its promise is: **Your business. Your time. Beautifully organised.** The product will make staff scheduling and appointment administration efficient while keeping customer booking straightforward.

The visual direction is professional, approachable, and calm: deep teal and emerald, warm neutrals, restrained gold accents, readable typography, deliberate spacing, and responsive layouts. The product must avoid generic dashboard patterns and must make loading, empty, validation, and error states intentional.

## Architecture and technology decisions

- **Language:** TypeScript throughout application code.
- **Web application:** React with Vite for a responsive client and a separately structured HTTP API.
- **Server:** Node.js with Express; the server owns authentication, authorization, validation, persistence, and business rules.
- **Persistence:** SQLite for the initial single-instance deployment, with schema migrations and foreign keys. Keep persistence behind focused modules so a multi-instance deployment can move to a transactional server database.
- **Authentication:** Passwords are stored only as salted, memory-hard hashes; opaque, random session tokens are stored hashed and sent using secure, HTTP-only cookies. Enforce server-side role checks and business scoping on every protected operation.
- **Validation:** Validate untrusted input at API boundaries and return explicit, useful errors without leaking credentials or private records.
- **Scheduling:** Keep date/time calculations and booking rules in pure TypeScript domain modules, independent of HTTP and UI. Store instants in UTC and business time zones as IANA identifiers. Inject the clock into time-dependent services.
- **Concurrency:** Booking creation must use a database transaction and enforce slot conflicts in persistence, not rely on a prior availability response. SQLite is the initial single-instance choice; production multi-instance deployment requires a shared database with equivalent transaction/locking constraints.
- **Dependencies:** Add only packages that provide direct application value. Keep secrets, databases, and generated output out of source control.

## Data model

All business-owned records carry a `business_id`; API reads and writes must scope these records to the authenticated business.

- **User:** id, normalized email, password hash, display name, role (`owner`, `staff`, `customer`), timestamps.
- **Business:** id, owner user id, name, IANA time zone, locale, policy settings, timestamps.
- **StaffProfile:** id, business id, user id, active state.
- **Service:** id, business id, name, description, duration, price in integer minor currency units, buffer, category, online-booking state, active state.
- **StaffService:** business id, staff id, service id (eligibility relation).
- **BusinessHours / StaffHours:** business or staff id, weekday, one or more local-time periods.
- **AvailabilityException:** business/staff id, local date/time range, kind (`break`, `time_off`, `opening_override`).
- **CustomerProfile:** business id, user id or guest contact, contact details.
- **Appointment:** business/staff/customer ids, UTC start/end, state, reference, immutable service and price snapshots, cancellation metadata, timestamps.
- **AppointmentEvent:** appointment id, actor, event type, prior/new details, reason, timestamp.
- **WaitlistEntry:** business/customer ids, service preferences, preferred staff and local-time range, expiry and state.
- **Reminder:** appointment id, channel, scheduled instant, delivery state, attempts, idempotency key.

Use foreign keys, unique constraints, indexes, and explicit deletion/retention rules. A service edit must not rewrite historical appointment snapshots.

## Ordered implementation phases

### Phase 0 — Project setup and product documentation

**Dependencies:** None.

- Establish the repository ignore rules and project documentation.
- Choose and document the initial application architecture and persistence boundary.
- Add setup, run, configuration, migration, and manual verification instructions.

**Completion criteria:** Tracked docs accurately describe the selected architecture and planned phases; generated files, secrets, and local data are ignored.

### Phase 1 — Accounts, authentication, and roles

**Dependencies:** Phase 0.

- Implement registration, login, logout, session expiry, and password reset foundations.
- Hash passwords and persisted session tokens; use safe cookie settings.
- Enforce owner, staff, and customer access rules and business-level isolation.
- Build usable sign-in, registration, and authenticated application entry screens with validation and error states.

**Completion criteria:** Users can register, sign in/out, and retain a session; protected operations reject unauthenticated or unauthorized requests and isolate business data.

### Phase 2 — Business and service catalogue

**Dependencies:** Phase 1.

- Business settings and time zone.
- Service create/edit/deactivate, pricing, duration, buffers, online-booking policy, categories, and staff eligibility.
- Preserve historical service snapshots.

**Completion criteria:** An owner can manage the business catalogue and staff eligibility; inactive services are unavailable for new online bookings without changing old appointments.

### Phase 3 — Staff management and availability configuration

**Dependencies:** Phases 1 and 2.

- Staff profiles and service assignments.
- Business opening hours and staff weekly schedules with multiple periods.
- Recurring breaks, dated exceptions, holidays, and partial/full-day time off.

**Completion criteria:** Authorized owners can configure schedules and staff cannot be treated as available outside business and personal working periods.

### Phase 4 — Scheduling and availability engine

**Dependencies:** Phases 2 and 3.

- Implement deterministic slot generation as a domain module with injected clock.
- Apply business hours, staff hours, breaks, time off, existing appointments, buffers, slot interval, notice, and booking horizon.
- Resolve local-time ambiguity and nonexistent DST times explicitly using IANA zones; never assume a fixed UTC offset.
- Support eligible staff and multi-service duration/buffer calculations.

**Completion criteria:** The same explicit inputs and clock produce the same valid slots across normal days and DST transitions; invalid or ambiguous local times are handled by a documented policy.

### Phase 5 — Booking lifecycle and conflict prevention

**Dependencies:** Phases 1–4.

- Customer booking flow, booking references, confirmation, and persisted service snapshots.
- Valid state transitions for pending, confirmed, completed, cancelled, and no-show.
- Atomic persistence conflict checks including buffers and multi-service bookings.

**Completion criteria:** Customers can book eligible slots and simultaneous competing requests cannot create overlapping appointments.

### Phase 6 — Cancellation, rescheduling, and waitlist

**Dependencies:** Phase 5.

- Notice rules, cancellation reasons/history and fee recording.
- Transactional rescheduling with availability revalidation and audit history.
- Waitlist matching, expiration, and controlled slot promotion that prevents duplicate offers from becoming confirmed bookings.

**Completion criteria:** Authorized changes follow configured policies, preserve history, and release or reserve availability safely.

### Phase 7 — Reminders, customer engagement, and analytics

**Dependencies:** Phases 1, 5, and 6.

- Clock-injected reminder scheduling, idempotency, cancellation suppression, retry state, and supported delivery channels.
- Customer booking/cancellation/no-show history.
- Metrics derived from persisted appointment and service snapshots.

**Completion criteria:** Reminders are not duplicated or sent for cancelled bookings, and business metrics reflect actual records.

## Scheduling rules and edge cases

- Persist appointment start/end as UTC instants; keep the business IANA zone for converting configured wall-clock schedules.
- A slot must fit the complete service chain plus its applicable buffers inside a continuous valid working period.
- A conflict includes appointment occupancy and the configured buffer; cancelled appointments do not block availability.
- Intersect business opening periods with staff working periods, then subtract breaks, time off, and occupied ranges.
- Enforce minimum booking notice and maximum advance horizon against the injected current instant.
- Reject malformed dates, invalid IANA zones, non-positive durations, invalid intervals, and impossible service combinations explicitly.
- For a nonexistent spring-forward wall time, do not silently shift it to another time. For an ambiguous fall-back wall time, distinguish instants by offset and present unambiguous choices.
- Recheck availability within the booking transaction. Preserve appointment snapshots and audit cancellation/rescheduling transitions.
- Never reveal whether a private record belongs to another business; return the repository-standard not-found/authorization response.

## Error handling and security

- Normalize emails consistently; use unique database constraints to close registration races.
- Never log passwords, raw session tokens, reset tokens, or sensitive customer details.
- Apply secure cookie settings in production, session expiration, CSRF protections for cookie-authenticated mutations, and request validation.
- Enforce role and business ownership in server-side services, not by hiding client controls.
- Use explicit typed error responses; unexpected server errors must not be reported as successes.
- Keep secrets in local environment configuration and provide only a non-secret `.env.example` if configuration is introduced.

## Progress and implementation decisions

- [x] Phase 0 — project setup and product documentation.
- [ ] Phase 1 — accounts, authentication, and roles.
- [ ] Phase 2 — business and service catalogue.
- [ ] Phase 3 — staff management and availability configuration.
- [ ] Phase 4 — scheduling and availability engine.
- [ ] Phase 5 — booking lifecycle and conflict prevention.
- [ ] Phase 6 — cancellation, rescheduling, and waitlist.
- [ ] Phase 7 — reminders, customer engagement, and analytics.

**Current state:** Repository inspection found only a license, Git metadata, and the ignored source brief in `plan/Bookora.md`; there was no application scaffold or dependency manifest. The existing remote and `main` branch are retained. The source brief remains ignored and unchanged; this tracked file is the implementation source of truth.

**Next feature:** Phase 1 — accounts, authentication, and roles. Complete it end-to-end before moving on.

## Completion workflow

Implement one phase at a time. Manually verify the actual feature and its important error/edge cases; do not generate automated test suites per the product brief. Update this plan with implementation decisions and limitations, review the scoped changes, and create one descriptive commit per completed phase. Do not push. Stop after the current feature and wait for an explicit request to continue.
