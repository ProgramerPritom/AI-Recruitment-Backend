# Aironauts AI Recruiting Co-Worker — Backend API & Worker Engine

A robust, enterprise-grade backend API, state machine, and asynchronous worker system powering the conversational AI recruiting co-worker. Built with **Node.js**, **Express**, **TypeScript**, **MongoDB (Mongoose)**, **BullMQ**, and **Google Gemini (`@google/generative-ai`)**.

---

## 1. System Architecture

The backend is built as an enterprise **Modular Monolith** with clear boundaries between the conversational agent, domain business services, background worker queues, and the deterministic candidate state machine.

```
                            RECRUITER / FRONTEND UI
                                      │
                                      ▼
                             Express REST API
                       (/api/chat, /api/jobs, etc.)
                                      │
             ┌────────────────────────┴────────────────────────┐
             ▼                                                 ▼
      AI Agent Service                                 Domain Services
   (Google Gemini Flash)                      (Jobs, Candidates, Outreach)
   - Function Calling Tools                            - State Machine
   - Compound Query Pre-Resolver                       - Scoring Engine
             │                                                 │
             └────────────────────────┬────────────────────────┘
                                      ▼
                              MongoDB / Mongoose
                           (Authoritative Datastore)
                                      │
             ┌────────────────────────┴────────────────────────┐
             ▼                                                 ▼
       BullMQ Queues                                     Activity Log
    (Redis with in-process                           (Full Recruiter Audit
       graceful fallback)                               & State History)
             │
             ▼
     Background Workers
     ├── 1. Candidate Sourcing Worker (Serper / High-Fidelity Mock)
     ├── 2. Candidate Scoring Worker (Gemini 0-100 Rubric)
     └── 3. Outreach Sending Worker (Idempotent Virtual Outbox)
             │
             ▼
     Server-Sent Events (SSE)
     (/api/tasks/:taskId/events)
```

---

## 2. Completed Requirement Verification Matrix

All technical requirements specified in the project specification and recruiter checklist are fully implemented, tested, and active:

| # | Requirement | Implementation Mechanism | Backend Source File |
|---|---|---|---|
| **1** | **No Duplicate Emails** (একই candidate-কে একই step দ্বিতীয়বার send না করা) | Compound unique index `{ campaignId: 1, candidateId: 1, stepNumber: 1 }` on `CampaignDelivery`. Millisecond pre-flight suppression check. | `src/modules/campaigns/campaignDelivery.model.ts`<br>`src/workers/outreach.worker.ts` |
| **2** | **Background Sending Queue** (Sending background job হিসেবে চালানো) | BullMQ queue `outreachQueue` processes dispatches asynchronously without blocking HTTP threads. | `src/queues/outreach.queue.ts`<br>`src/workers/outreach.worker.ts` |
| **3** | **Retry Mechanism on Failure** (Sending failure হলে retry implement করা) | BullMQ 3 retry attempts with exponential backoff (`delay: 1000ms`, `backoff: exponential`). | `src/queues/outreach.queue.ts`<br>`src/workers/outreach.worker.ts` |
| **4** | **`POST /simulate-reply` Endpoint** (POST /simulate-reply endpoint তৈরি) | Dedicated endpoints supporting both `POST /api/simulate-reply` (with `candidateId` in body) and `POST /api/candidates/:candidateId/simulate-reply`. | `src/modules/replies/reply.routes.ts`<br>`src/modules/replies/reply.controller.ts` |
| **5** | **UI Simulated Reply Button** | Full support for UI triggers with preset realistic replies across all 5 candidate intents. | `src/modules/replies/reply.controller.ts` |
| **6** | **Mock / Virtual Outbox** (Real inbox integration না থাকলে mock করা) | Zero-config in-memory & MongoDB sandboxed Virtual Outbox (`EmailProvider`). Delivers 100% reliable simulation without requiring paid email API credentials. | `src/integrations/email/emailProvider.ts`<br>`src/modules/campaigns/campaign.service.ts` |
| **7** | **5-Intent Reply Classification** (Interested reply classify করা) | Gemini-powered semantic classifier categorizing replies into: `interested`, `not_interested`, `question`, `out_of_office`, `later`. | `src/modules/replies/reply.service.ts` |
| **8** | **Meeting Booking Links** (Meeting booking link তৈরি) | Interactive calendar invitation generator with customized recruiter booking URLs. | `src/modules/meetings/meeting.service.ts` |
| **9** | **Mock Time-Slot Picker** (Calendly অথবা mock time-slot picker) | Generates dynamic 30-minute interview slots (Today, Tomorrow, +2d) and confirms selection. | `src/modules/meetings/meeting.service.ts`<br>`src/agent/agent.tools.ts` |
| **10** | **`meeting_booked` Status Transition** | State machine moves candidate from `interested` to `meeting_booked` upon slot confirmation. | `src/shared/stateMachine.ts`<br>`src/modules/meetings/meeting.service.ts` |
| **11** | **`interview` Status Transition** | Recruiter progresses candidate to live interview stage. | `src/shared/stateMachine.ts`<br>`src/modules/candidates/candidate.service.ts` |
| **12** | **`shortlisted` Status Transition** | Candidates passing initial technical evaluation advance to shortlist. | `src/shared/stateMachine.ts`<br>`src/modules/candidates/candidate.service.ts` |
| **13** | **`hired` Status Transition** | Terminal positive state: marks candidate successfully hired. | `src/shared/stateMachine.ts`<br>`src/modules/candidates/candidate.service.ts` |
| **14** | **`rejected` Status Transition** | Terminal/revertible negative state: candidate disqualified with feedback log. | `src/shared/stateMachine.ts`<br>`src/modules/candidates/candidate.service.ts` |
| **15** | **Status Update via Chat Commands** | Natural language conversational instructions (e.g. *"accept candidate who have above score 80"*, *"undo accepted to sourced"*, *"reject candidate Olly"*) mapped to deterministic state transitions. | `src/agent/agent.service.ts`<br>`src/agent/agent.tools.ts` |
| **16** | **Status Update via UI** | Direct REST API `PATCH /api/candidates/:candidateId/status` invoked via Candidate Workspace table and detail modals. | `src/modules/candidates/candidate.routes.ts`<br>`src/modules/candidates/candidate.controller.ts` |
| **17** | **Activity Audit Logging** (প্রতিটি status change activity log-এ save করা) | Centralized `ActivityService` logs every recruiter action, status transition, agent invocation, and email dispatch with timestamp and actor metadata. | `src/modules/activity/activity.service.ts`<br>`src/modules/activity/activity.model.ts` |

---

## 3. How Email Sending Works Without Paid API Keys

> **Question: *"Mail er API key na dile eta mail send korbe kivabe? Eta ki possible?"***

### The Virtual Outbox Architecture

In production recruitment software and technical ATS evaluations, connecting directly to a real SMTP server during early testing creates severe risks:
1. Candidate inboxes would be spammed with test messages.
2. Paid services (SendGrid, Mailgun, AWS SES) require domain DNS verification (DKIM/SPF) and charge per transmission.
3. Third-party rate limits can stall automated evaluations.

To solve this, Aironauts implements a **Dual-Mode Email Provider (`src/integrations/email/emailProvider.ts`)**:

```
                       Outreach Sending Worker
                                  │
                                  ▼
                     EmailProvider.sendEmail()
                                  │
                 ┌────────────────┴────────────────┐
                 ▼                                 ▼
      [No SMTP Key Configured]           [SMTP Credentials in .env]
                 │                                 │
                 ▼                                 ▼
         VIRTUAL OUTBOX                     REAL SMTP RELAY
   - Saved to MongoDB `CampaignDelivery`     - Nodemailer / Mailtrap
   - Recipient, subject, body persisted     - Sent to actual inbox
   - Variable placeholders replaced         - Production delivery
   - Visible in UI Delivery Monitor
   - 100% Zero-Cost & 100% Safe
```

### Key Safety Guarantees of the Virtual Outbox:
- **Real-Time Visibility:** Every outgoing email is saved to MongoDB and can be inspected via `GET /api/campaigns/:campaignId/deliveries` or `GET /api/email/outbox`.
- **Variable Sanitization:** Template variables like `{{name}}` are replaced with the candidate's real name (e.g. `Badruzzaman Pritom`), and `[Your Name]` is converted to `Talent Acquisition Team`.
- **Pre-Flight Suppression:** If a candidate replies or unsubscribes between batch scheduling and worker execution, the outbox suppresses the message immediately.
- **Easy Production Switch:** If you provide live credentials in `.env`, the engine automatically switches from the Virtual Outbox to real email delivery:
  ```env
  SMTP_HOST=smtp.mailtrap.io
  SMTP_PORT=2525
  SMTP_USER=your_user
  SMTP_PASS=your_password
  SMTP_FROM="recruiting@yourcompany.com"
  ```

---

## 4. Candidate State Machine

The recruitment pipeline is strictly governed by `src/shared/stateMachine.ts`. Every transition is validated against an authoritative transition graph, preventing illegal or nonsensical stage skips.

### Authoritative Status Transition Graph

```
                      ┌──────────────┐
                      │   sourced    │◀──────────────┐
                      └──────┬───────┘               │
                             │                       │ (Undo / Revert)
                 ┌───────────┴───────────┐           │
                 ▼                       ▼           │
          ┌─────────────┐         ┌────────────┐     │
          │  accepted   │─────────│  rejected  │     │
          └──────┬──────┘         └────────────┘     │
                 │ (Undo)                            │
                 ├───────────────────────────────────┘
                 ▼
          ┌─────────────┐
          │  contacted  │
          └──────┬──────┘
                 │ (Candidate replies)
                 ▼
          ┌─────────────┐
          │   replied   │
          └──────┬──────┘
                 │
         ┌───────┴───────────────┐
         ▼                       ▼
  ┌─────────────┐         ┌───────────────┐
  │ interested  │         │not_interested │
  └──────┬──────┘         └───────────────┘
         │ (Time-slot confirmed)
         ▼
  ┌───────────────┐
  │meeting_booked │
  └──────┬────────┘
         │
         ▼
  ┌─────────────┐
  │  interview  │
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │ shortlisted │
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │    hired    │ (Terminal Success)
  └─────────────┘
```

### Complete Transition Rules:
| Current Status | Allowed Target Transitions |
|---|---|
| `sourced` | `accepted`, `rejected` |
| `accepted` | `contacted`, `rejected`, `sourced` *(allows recruiter undo)* |
| `contacted` | `replied`, `unsubscribed`, `sourced` |
| `replied` | `interested`, `not_interested`, `unsubscribed`, `rejected` |
| `interested` | `meeting_booked`, `rejected`, `interview` |
| `not_interested` | `rejected`, `sourced` |
| `meeting_booked` | `interview`, `rejected` |
| `interview` | `shortlisted`, `rejected`, `hired` |
| `shortlisted` | `hired`, `rejected` |
| `hired` | *None (Terminal Goal)* |
| `rejected` | `sourced` *(allows recruiter reconsideration)* |

---

## 5. API Reference Guide

### 5.1 Job Management
- **`POST /api/jobs/extract`**: Accepts `{ rawText: string }`, uses Gemini to extract title, seniority, location, skills, and scoring rubric. Does not persist.
- **`POST /api/jobs`**: Persists verified job requirements to MongoDB.
- **`GET /api/jobs`**: Returns all recruitment jobs.
- **`GET /api/jobs/:jobId`**: Returns single job details.

### 5.2 Candidate Pipeline
- **`POST /api/jobs/:jobId/candidates/import`**: Uploads CSV or JSON candidates with automatic deduplication.
- **`GET /api/jobs/:jobId/candidates`**: Lists candidates with optional query filters:
  - `status` (e.g. `?status=accepted`)
  - `search` (e.g. `?search=Pritom`)
  - `sortBy` & `sortOrder`
- **`PATCH /api/candidates/:candidateId/status`**: Transitions candidate status with state-machine validation.
- **`POST /api/jobs/:jobId/candidates/bulk-review`**: Accepts `{ candidateIds: string[], decision: 'accept' | 'reject' }` or `{ minScore: 80, decision: 'accept' }`.

### 5.3 Background Sourcing & Scoring
- **`POST /api/jobs/:jobId/sourcing`**: Triggers background worker to source candidate profiles via Serper Google Search (or realistic mock engine). Returns `{ taskId }`.
- **`POST /api/jobs/:jobId/scoring`**: Evaluates all sourced candidates against the job rubric (0-100 score + reasoning). Returns `{ taskId }`.
- **`GET /api/tasks/:taskId/events`**: Server-Sent Events (SSE) streaming live percentage progress to the frontend.
- **`GET /api/tasks/:taskId`**: Returns current task status (supports page refresh recovery).

### 5.4 Outreach & Virtual Outbox
- **`POST /api/jobs/:jobId/campaigns`**: Generates multi-step outreach copy (Initial email, 3-day follow-up, 7-day follow-up).
- **`PATCH /api/campaigns/:campaignId`**: Updates email subject/body copy. Invalidates prior approval hash.
- **`POST /api/campaigns/:campaignId/approve`**: Recruiter safety sign-off. Generates cryptographic SHA-256 approval hash.
- **`POST /api/campaigns/:campaignId/send`**: Dispatches batch to BullMQ outreach worker for safe virtual delivery.
- **`GET /api/campaigns/:campaignId/deliveries`**: Returns delivery status log for campaign recipients.
- **`GET /api/email/outbox`**: Returns all virtual outbox messages across campaigns.

### 5.5 Reply Simulation & Intent Classification
- **`POST /api/simulate-reply`** or **`POST /api/candidates/:candidateId/simulate-reply`**:
  ```json
  {
    "candidateId": "6aeae301e2ab5cbb1803d1cf",
    "replyText": "Hi team, I would love to discuss this Senior AI Engineer role. When are you free?"
  }
  ```
  Classifies intent (`interested`) and updates candidate status.
- **`POST /api/replies/:replyId/send`**: Sends recruiter response back to candidate.

### 5.6 Meetings & Calendar
- **`POST /api/candidates/:candidateId/book-meeting`**:
  ```json
  {
    "slot": "Tomorrow at 2:00 PM EST",
    "interviewer": "Engineering Lead"
  }
  ```
  Transitions candidate to `meeting_booked` and generates calendar invite link.
- **`GET /api/jobs/:jobId/meetings`**: Lists all scheduled interviews.

### 5.7 Conversational AI Co-Worker
- **`POST /api/chat/message`**:
  ```json
  {
    "sessionId": "session_1793786028",
    "jobId": "6aeae039f88a2c13ca768991",
    "message": "accept candidate who have above score 80"
  }
  ```
  Returns assistant response with markdown commentary and optional interactive action cards (`JobConfirmCard`, `CandidateReviewCard`, `EmailPreviewCard`, `MeetingSlotCard`, etc.).
- **`GET /api/chat/history/:sessionId`**: Streams complete session chat history.

### 5.8 Analytics & Audit Trail
- **`GET /api/jobs/:jobId/stats`**: Returns pipeline stage counts and conversion percentages.
- **`GET /api/jobs/:jobId/summary`**: Generates AI executive summary analyzing recruitment bottlenecks and next steps.
- **`GET /api/jobs/:jobId/activity`**: Returns chronological audit log.

---

## 6. Conversational Chat Commands Guide

The AI Co-Worker supports natural language instructions for all recruitment operations. The table below lists example prompts:

| Goal | Example Natural Language Prompt | What the System Does |
|---|---|---|
| **Create Job** | *"I need a Senior MERN AI Engineer with 7+ years experience in React and Node"* | Extracts JD, generates scoring rubric, presents `JobConfirmCard`. |
| **Source Talent** | *"Find 5 candidates from the web for this job"* | Queues Serper sourcing worker, displays `LiveProgressCard` with SSE stream. |
| **Score Talent** | *"Score all candidates against the rubric"* | Runs LLM evaluation engine, generates 0-100 match ratings with evidence. |
| **Accept Candidates by Score** | *"accept candidate who have above score 80"* | Evaluates scores and marks all candidates $\ge 80$ as `accepted`. |
| **Undo / Revert Decisions** | *"undo accepted status to sourced. only Badruzzaman Pritom candidate accepted"* | Reverts others back to `sourced`, keeping only the named candidate `accepted`. |
| **Inspect Profile** | *"shared 6aeae301e2ab5cbb1803d1cf this id person experience, techonlogies and linkedin profile"* | Returns single candidate profile card with skills, score, and LinkedIn link. |
| **Draft Outreach** | *"Draft an outreach campaign for accepted candidates"* | Creates 3-step sequence with personalized tokens, presents `EmailPreviewCard`. |
| **Approve & Send** | *"Approve the campaign and send step 1"* | Creates SHA-256 approval hash, enqueues BullMQ outreach jobs to Virtual Outbox. |
| **Simulate Reply** | *"Simulate an interested reply from Badruzzaman Pritom"* | Ingests reply, runs 5-intent classifier, moves candidate to `interested`. |
| **Book Interview** | *"Book an interview slot with Pritom for tomorrow at 2 PM"* | Transitions candidate to `meeting_booked`, returns calendar invitation link. |

---

## 7. Local Setup & Installation

### Prerequisites
- **Node.js**: v18.0.0 or higher (v20+ recommended)
- **MongoDB**: Running locally on `mongodb://127.0.0.1:27017/aironauts` or via Docker
- **Redis** *(Optional)*: If Redis is offline, BullMQ queues fall back seamlessly to in-process execution.

### Step-by-Step Setup

```bash
# 1. Clone repository and navigate to backend
cd aironut-backend

# 2. Install dependencies
npm install

# 3. Create .env configuration
cp .env.example .env

# 4. Fill in environment variables
# Required:
# GEMINI_API_KEY=your_gemini_api_key
# MONGODB_URI=mongodb://127.0.0.1:27017/aironauts
# PORT=5000

# 5. Populate sample demo data (Job, candidates, scoring, campaign)
npm run seed

# 6. Start development server
npm run dev
```

The server will start at **`http://localhost:5000`**.  
Health check endpoint: `GET http://localhost:5000/health`

### TypeScript Compilation Check
To verify complete type safety across all files:
```bash
npx tsc --noEmit
```
Output: `0 errors`.

---

## 8. Docker Deployment

To spin up the entire backend stack including MongoDB and Redis via Docker Compose:

```bash
# Start MongoDB, Redis, and Backend API
docker compose up -d

# Check running containers
docker compose ps

# View backend logs
docker compose logs -f backend
```
