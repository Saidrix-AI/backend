# Industry-Level Authentication — Saidrix AI Tutor

Date: 2026-07-15
Status: Approved, implementing

## Goal

Replace the current single-JWT auth with an industry-standard, hard-to-abuse
authentication system: short-lived access tokens + rotating refresh tokens
(httpOnly cookie), email verification (OTP), password reset, strong request
hardening, and a fully wired-up frontend.

## Decisions (approved)

- **Session model**: access + refresh, refresh in httpOnly/Secure/SameSite=strict cookie.
- **Scope**: harden login/register, email verification (OTP), password reset, frontend wire-up.
- **Hardening depth**: strong baseline (not full-paranoid; no HIBP/2FA/audit-log yet).
- **Email**: `nodemailer` when SMTP env present, else dev console fallback (SMTP creds provided later).
- **Username**: keep the existing UI's username field — User gets a unique `username`; login accepts email OR username.

## Architecture

### Tokens
- **Access token** — JWT HS256, 15m, returned in JSON body, held in frontend memory (React context; never localStorage). Sent as `Authorization: Bearer`. Verified with `algorithms: ["HS256"]` pinned.
- **Refresh token** — opaque `crypto.randomBytes(32)` hex, NOT a JWT. Stored:
  - client: httpOnly + Secure + SameSite=strict cookie, path `/api/auth`.
  - server: sha256 hash in `RefreshToken` collection with `expiresAt` (30d, TTL index).
  - **rotated** every `/refresh`; reuse of an already-rotated token ⇒ theft ⇒ revoke all user tokens.
- **Silent refresh** — on app mount frontend calls `/api/auth/refresh` (cookie auto-sent) to restore session after a page reload.
- **CSRF** — access token lives in a header (not a cookie) so main API is CSRF-safe; refresh endpoint protected by SameSite=strict.

### Data model
- **User** (extend): add `username` (unique), `emailVerified` (bool, default false), `emailVerifiedAt?`, `failedLoginAttempts` (default 0), `lockedUntil?`.
- **RefreshToken** (new): `userId`, `tokenHash`, `expiresAt` (TTL), `userAgent?`, `ip?`.
- **VerificationToken** (new): `userId`, `type` (`email_verify` | `password_reset`), `codeHash`, `expiresAt` (TTL), `attempts`.

### Endpoints (`/api/auth`)
| Method | Path | Purpose |
|---|---|---|
| POST | `/register` | create user (emailVerified=false), issue tokens, send OTP |
| POST | `/login` | lockout check → timing-safe verify → issue tokens |
| POST | `/refresh` | rotate refresh cookie → new access token |
| POST | `/logout` | delete refresh token + clear cookie |
| POST | `/verify-email` | `{ code }` verify OTP → emailVerified=true |
| POST | `/resend-otp` | (strict limit) new OTP |
| POST | `/forgot-password` | `{ email }` — always 200; if user exists, email reset code |
| POST | `/reset-password` | `{ token, newPassword }` → update pw + revoke all refresh tokens |
| GET | `/me` | (requireAuth) current user |

### Hardening (baseline)
- Strict `authLimiter` on login/register/forgot/verify/resend (IP-scoped, ~10/15m) on top of the global 60/min.
- Account lockout: 5 failed logins ⇒ 15m `lockedUntil`.
- Timing-safe login: run bcrypt.compare against a dummy hash when the user is missing (no enumeration).
- JWT algorithm pinned; `JWT_ACCESS_SECRET` min 32 chars.
- bcrypt rounds 10 → 12.
- Helmet with explicit CSP + HSTS (prod); CORS allowlist from env with `credentials: true`.
- Remove the dev-bypass user from `requireAuth` (frontend now does real auth).
- `cookie-parser` added.
- Password policy: min 8 + at least one letter and one number (zod refine).

### Frontend
- `AuthContext` — `user`, in-memory `accessToken`, `login/register/logout/verifyEmail/…`, `loading`.
- `api.js` — attach Bearer, `credentials: 'include'`, on 401 retry once via `/refresh`.
- Silent `/refresh` on mount; `ProtectedRoute` redirects to `/login`.
- Wire Login / CreateAccount / VerifyEmail; add ForgotPassword + ResetPassword pages.

### New env
`JWT_ACCESS_SECRET`, `JWT_ACCESS_EXPIRES_IN=15m`, `REFRESH_TOKEN_EXPIRES_IN=30d`,
`CORS_ORIGIN`, `COOKIE_DOMAIN?`, `SMTP_HOST/PORT/USER/PASS?`, `MAIL_FROM?`.
(`JWT_SECRET` is renamed to `JWT_ACCESS_SECRET`.)

### New deps
Backend: `cookie-parser` (+ `@types/cookie-parser`), `nodemailer` (+ `@types/nodemailer`).

## Phases
1. Data model + config + mailer util + deps.
2. Core auth service refactor (access+refresh, rotation, lockout, timing-safe) + hardened middleware + security headers.
3. Email verification (OTP) + password reset endpoints.
4. Frontend auth (context, api refresh, protected routes, wire + new pages).
5. Verification & tests.

## Verification
- `npm run typecheck` (backend + frontend) clean.
- Backend integration tests (supertest + mongodb-memory-server): register→verify→login→refresh→logout, lockout after 5 fails, reset-password revokes tokens, enumeration-safe forgot-password.
- Manual browser flow through Create Account → Verify → Dashboard, Login, Forgot/Reset.
