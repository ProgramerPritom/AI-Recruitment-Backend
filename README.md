# Aironauts AI Recruiting Co-Worker — Backend

A robust, enterprise-grade backend API and asynchronous worker system powering the conversational AI recruiting co-worker. Built with Node.js, Express, TypeScript, MongoDB (Mongoose), BullMQ, and Google Gemini.

---

## 1. Architecture Overview

The system is architected as a **Modular Monolith** with clear separation of concerns:

```
                       RECRUITER / UI
                             │
                             ▼
                    Express REST API
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
      AI Agent Service                 Domain Services
   (Gemini Tool Calling)          (Jobs, Candidates, Outreach)
            │                                 │
            └────────────────┬────────────────┘
                             ▼
                     MongoDB / Mongoose
                    (Authoritative Truth)
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
     BullMQ + Redis                     Activity Log
   (Task Queues & Locks)           (Audit Trail & History)
            │
            ▼
    Background Workers
    - Candidate Sourcing
    - Candidate Scoring
    - Outreach Safe Sending
            │
            ▼
    Server-Sent Events (SSE)
    (Live UI Progress Streaming)
```

---

## 2. Core Modules & Endpoints

| Module | Method | Endpoint | Description |
|---|---|---|---|
| **Jobs** | POST | `/api/jobs/extract` | Extract structured requirements from raw JD text (does not save) |
| | POST | `/api/jobs` | Confirm and persist a verified active job |
| | GET | `/api/jobs` | List all active recruitment jobs |
| | GET | `/api/jobs/:jobId` | Get single job details |
| **Candidates** | POST | `/api/jobs/:jobId/candidates/import` | Upload candidate CSV with automatic deduplication & validation |
| | GET | `/api/jobs/:jobId/candidates` | List candidates with status filtering & score sorting |
| | PATCH | `/api/candidates/:candidateId/status` | Centralized state-machine transition (accept, reject, hire, etc.) |
| | POST | `/api/jobs/:jobId/candidates/bulk-review` | Bulk accept/reject candidates |
| **Sourcing & Scoring** | POST | `/api/jobs/:jobId/sourcing` | Start background candidate sourcing task |
| | POST | `/api/jobs/:jobId/scoring` | Score candidates against job rubric |
| **Tasks & SSE** | GET | `/api/tasks/:taskId/events` | Real-time Server-Sent Events (SSE) progress stream |
| | GET | `/api/tasks/:taskId` | Retrieve background task status (state recovery after refresh) |
| **Outreach** | POST | `/api/jobs/:jobId/campaigns` | Generate personalized multi-step outreach draft |
| | PATCH | `/api/campaigns/:campaignId` | Edit draft steps (invalidates prior approval if modified) |
| | POST | `/api/campaigns/:campaignId/approve` | Explicit recruiter approval barrier |
| | POST | `/api/campaigns/:campaignId/send` | Idempotent email delivery with pre-flight suppression |
| | GET | `/api/campaigns/:campaignId/deliveries` | Inspect delivery logs |
| | GET | `/api/email/outbox` | View virtual outbox messages |
| **Replies** | POST | `/api/candidates/:candidateId/simulate-reply` | Ingest reply & classify into 5 intents |
| | POST | `/api/replies/:replyId/send` | Send approved response to candidate |
| **Meetings** | POST | `/api/candidates/:candidateId/book-meeting` | Confirm interview slot & mark `meeting_booked` |
| | GET | `/api/jobs/:jobId/meetings` | List booked meetings |
| **Chat & Agent** | POST | `/api/chat/message` | Conversational recruitment assistant with tool calling |
| | GET | `/api/chat/history/:sessionId` | Chat history stream surviving page refreshes |
| **Analytics** | GET | `/api/jobs/:jobId/stats` | Funnel counts and conversion rates |
| | GET | `/api/jobs/:jobId/summary` | AI-generated executive progress summary |
| **Audit** | GET | `/api/jobs/:jobId/activity` | Chronological activity audit trail |

---

## 3. Key Design Decisions, Limitations & Trade-offs

### 3.1 LLM & Agent Approach
- **Choice:** Google Gemini (`gemini-2.0-flash` / `gemini-1.5-flash`) via the official `@google/generative-ai` SDK using **Function Calling (Plain Tool Calling)**.
- **Rationale:** Tool-calling agents provide deterministic boundaries. Unlike autonomous multi-agent loops that can hallucinate database writes, tool-calling ensures every mutation passes through strict Zod schema validation and business services.
- **Safety:** The agent proposes actions via interactive UI cards; writes and sends are never executed without recruiter approval.

### 3.2 Resilience & Sourcing Strategy
- **Search Integration:** Connects to Serper Google Search API (`site:linkedin.com/in`). If no Serper API key is configured, the system automatically falls back to an internal **Deterministic High-Fidelity Mock Search Engine** that simulates realistic candidate profiles and LinkedIn URLs without scraping LinkedIn directly.
- **Email Delivery:** Configured for SMTP / Mailtrap, with an in-database/in-memory **Virtual Outbox** that allows complete inspection and zero-config demonstration without requiring external mail server credentials.

### 3.3 Idempotency & Safe Outreach
- Outreach messages use a compound unique index on `(campaignId, candidateId, stepNumber)`. Retrying a worker job will never send the same step to a candidate twice.
- **Pre-flight Status Check:** Milliseconds before dispatch, the worker checks the candidate's latest database status. If the candidate has replied or unsubscribed, outreach is automatically suppressed.

---

## 4. Local Quick Start

### Prerequisites
- Node.js v20+ or v24
- MongoDB (running on `mongodb://127.0.0.1:27017` or via Docker)
- Redis (optional for development; tasks seamlessly run in-process if Redis is offline)

### Setup & Run
```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env to supply your GEMINI_API_KEY (optional: SERPER_API_KEY)

# 3. Seed sample data (creates sample JD, candidates, scoring, and campaign)
npm run seed

# 4. Start development server
npm run dev
# Server will listen on http://localhost:5000
# Health check: http://localhost:5000/health
```

### Docker Compose
```bash
docker compose up -d
```

