# TDD 00 — Overview

> Part of the Omnichannel Commerce Platform TDD v1.2
>
> **v1.2 MVP scope:** single owner, own stores only. The SaaS layer (billing, plans, quotas,
> public signup, internal admin, referrals, AI) is deferred to Phase 2. Authoritative list:
> `INDEX.md` → "MVP scope". Where this file or any other describes those features as in scope,
> the `INDEX.md` section wins.

---

## 1. Purpose

Multi-tenant SaaS platform for omnichannel commerce that unifies:

- **Unified inbox** — WhatsApp, Instagram, Messenger in one place
- **Order management** — create and track orders directly from a conversation
- **Customer management** — unified profile across channels
- **Inventory tracking** — stock movements tied to orders
- **Extensible plugin system** — channels are plugins; third parties can build more

**Target user:** small and mid-size commerce operations in Latin America that sell
through social messaging and need to stop juggling three phone apps.

---

## 2. Architectural principles

These are decisions, not suggestions. Every implementation choice must be consistent with them.

1. **Multi-tenant from day one**
   `organizationId` / `storeId` on every table. Never retrofit tenancy.

2. **Plugin-first architecture**
   WhatsApp, Instagram and Messenger are official plugins using the same public SDK
   that third parties will use. Core messaging knows nothing about specific channels.

3. **Modular monolith (Nx)**
   Clear boundaries between modules, deployed as one service. Prepared for extraction
   into microservices later, but **do not** build microservices now.

4. **Cloud-native**
   Horizontally scalable, stateless services, replicable on demand.

5. **Progressive scalability**
   Start simple (Railway for the v1.2 MVP, then Cloud Run). Migrate to Kubernetes only when metrics justify it.
   Do not pre-optimize infrastructure.

6. **Security by default**
   Destructive-action confirmations, RLS in the database, secrets management,
   comprehensive audit logs.

7. **Observability first**
   Structured logs, metrics and health checks from day one — not bolted on later.

8. **Assistive AI by default**
   AI suggests; a human decides. Exactly two features may act without a human approving the
   specific action, and both are opt-in per store with their own consent: spam detection
   (reversible with one click) and the Scale-tier autonomous chatbot, which may only answer
   from approved sources, never performs writes, and hands off to a human on any doubt.
   Everything else is suggest-only. See `TDD_12_AI.md` §1 and §13.

---

## 3. Tech stack summary

```
Frontend    Next.js 16.4 (App Router) + React 19.2 + Tailwind 4.3 + shadcn/ui
Backend     NestJS 12 + Prisma 7.10 (pg driver adapter) + PostgreSQL 18.6 + Redis 8.10 (ioredis) + BullMQ 6.3
Realtime    Socket.io 4.8 + Redis Adapter
Deployment  Railway (v1.2 MVP) → Google Cloud Run (SaaS phase) → Kubernetes (migration path, MATURE)
Monorepo    Nx 23.2 workspace
Package mgr pnpm 11.25
Language    TypeScript 5.9 (strict mode) — 7.x deferred until typescript-eslint, ts-jest and Nx support it
Logger      Pino 10.3 (not Winston)
```

Exact pinned versions for every dependency, including Phase 2: `TDD_01_Architecture.md` §2.4.
Full rationale per layer: `TDD_01_Architecture.md` §2.

---

## 4. Domain glossary

Use these terms consistently in code, comments, UI copy and commit messages.

| Term | Definition |
|------|------------|
| **Organization** | Top-level tenant. Contains one or more Stores. |
| **Store** | An operational unit within an Organization. Has its own inbox, customers, orders, settings. |
| **Membership** | The link between a User and a Store, carrying a Role. A user can have different roles in different stores. |
| **User** | A person who logs into the platform (an agent, supervisor or admin). |
| **Customer** | An end consumer who messages the store. Not a platform user. |
| **CustomerIdentity** | A customer's handle on a specific channel (phone number, IG username, page-scoped ID). One Customer can have many. |
| **Conversation** | A thread between a Store and a Customer. Has a lifecycle state. |
| **Message** | A single entry in a conversation. Can be from customer, agent or system. |
| **Channel** | A messaging surface (WhatsApp, Instagram, Messenger, web widget). Implemented as a plugin. |
| **ChannelConnection** | A Store's link to one concrete account on a channel (a WhatsApp phone number, a Facebook Page, an Instagram business account, a widget site key). Its `connectionId` is what the provider sends as the *recipient* of a webhook; it is how the core knows which Store an inbound message belongs to. |
| **Plugin** | An installable extension. Channels are plugins. Third-party integrations are plugins. |
| **Billable conversation** (Phase 2; not built in the v1.2 MVP) | A conversation counted once per 24-hour window in which it received at least one inbound customer message. Windows are fixed UTC buckets starting at the conversation's first inbound message of that window (`TDD_11_Business.md` §2). The unit we charge for. |
| **Agent** | A User with an operational role in a Store's inbox. |
| **Seat** | An active Membership. Unlimited in the v1.2 MVP; counted against plan limits in Phase 2. |

---

## 5. Scope boundaries

### In scope for first implementation
- Unified inbox with WhatsApp, Instagram, Messenger, web widget (all four are channel plugins, `TDD_10_Plugins.md` §5)
- Conversation lifecycle (open, pending, resolved, snoozed, archived, spam)
- Customer profiles with cross-channel identity merging
- Order creation and status management from within a conversation
- Product catalog and robust inventory: warehouses that serve several stores, stock per warehouse, transfers and physical counts (`TDD_16_Inventory.md`)
- Shipping through carrier plugins: guides and labels (single and bulk), pickups, status updates to the customer through templates, order confirmation, cancellation with guide void, returns and exchanges (`TDD_17_Shipping.md`)
- Team management with roles and permissions
- Multi-store switching
- Plugin SDK, official channel plugins and the runtime for private and third-party integration plugins (the marketplace is deferred)
- Observability, security, backup

### Explicitly NOT in scope for first implementation
- SaaS layer (v1.2): billing with Stripe, plans and quotas, dunning, public signup, internal admin console, referral program, SaaS support, AI assist and autonomous chatbot (see `INDEX.md` → "MVP scope")
- Third-party plugin marketplace (SDK is built; marketplace is MATURE)
- Native mobile apps (PWA only in Phase 1)
- Elasticsearch (PostgreSQL FTS is sufficient)
- Kubernetes (Railway, then Cloud Run, until metrics justify migration)
- Data warehouse / BI stack (including the staff-facing cross-tenant analytics in `TDD_15_InternalAdmin.md` §10)
- DB-backed versioned plan editor (`TDD_15_InternalAdmin.md` §5) (the v1.2 MVP has no plans at all; see `INDEX.md` → "MVP scope")
- Third-party plugin marketplace UI and moderation queue (SDK, registry and official plugins are in scope)
- Video and voice calls
- Visual chatbot flow builder
- Multi-region deployment

Anything marked **MATURE** in the documents is deliberately deferred.

---

## 6. Success criteria for v1

The implementation is considered complete when:

- [ ] The seeded owner can log in, create a store and connect a first channel; an invitee opens the invitation link, accepts (creating their account when they have none) and gains access; signup without an invitation is rejected
- [ ] Inbound messages from all four channels land in the unified inbox in real time
- [ ] An agent can reply, assign, tag, snooze and resolve conversations
- [ ] An agent can create an order from a conversation without leaving the thread
- [ ] Customer profiles unify identities across channels
- [ ] A store admin can invite team members with distinct roles
- [ ] Tenant isolation is verified by automated security tests
- [ ] Observability stack reports logs, metrics and errors in production
- [ ] Backup restore has been tested end to end at least once

---

## 7. Document map

| Document | Read when |
|----------|-----------|
| `TDD_02_Conventions.md` | **Before writing any code** |
| `TDD_01_Architecture.md` | Building data models, tenancy, module structure |
| `IMPLEMENTATION_PLAN.md` | Deciding what to build next |
| All others | See `INDEX.md` |
