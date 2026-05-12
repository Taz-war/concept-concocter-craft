## SecureCase AI — Build Plan

A secure RAG system for legal case analysis: upload PDFs, ask questions, get answers grounded in citations.

### Stack adjustments from your spec

Your spec calls for Next.js + Supabase + OpenRouter + Resend. The Lovable template ships with **TanStack Start (React 19 + Vite)**, not Next.js, and Lovable provides integrated equivalents that remove the need for external accounts/keys:

- **Lovable Cloud** replaces Supabase (Postgres, Auth, Storage, RLS, edge functions) — same primitives, zero setup
- **Lovable AI Gateway** replaces OpenRouter — provides `google/gemini-2.5-flash` for Q&A and `google/text-embedding-004` (768-dim) for embeddings, with no external API key
- **Resend** can be added later via the Resend integration if/when transactional email is needed (not core to MVP)

Functionally identical to your spec; cheaper and no external accounts needed.

### Scope (MVP per your spec)

Auth → Matters CRUD → PDF upload + text extraction + chunking + embeddings → pgvector semantic search → grounded Q&A with citations → audit log. Multi-matter (your spec says one workspace, but listing multiple matters is already in the schema and pages).

### Database (Lovable Cloud / Postgres + pgvector)

Tables (with RLS, all scoped by `auth.uid()` ownership through `matters.user_id`):
- `profiles` (id = auth.users.id, email, full_name)
- `user_roles` + `app_role` enum + `has_role()` security-definer fn (per platform rule — roles never on profiles)
- `matters` (case_number, client_name, case_type, description, user_id)
- `documents` (matter_id, filename, storage_path, file_size, document_type, page_count, processed, raw_text)
- `chunks` (document_id, matter_id, chunk_text, chunk_index, page_number, embedding vector(768))
- `chat_history` (matter_id, query, response, source_documents jsonb, model_used, tokens_used)
- `audit_logs` (matter_id, user_id, action, details jsonb)

Indexes: ivfflat on `chunks.embedding` (cosine). RPC `match_chunks(query_embedding, match_matter_id, match_count)` for vector search filtered by matter.

Storage: private bucket `case-documents`, signed URLs only.

### Edge functions

- `process-document` — fetches PDF from storage, extracts text (pdfjs-dist), splits into ~1000-char/200-overlap chunks, embeds via Lovable AI, inserts chunks rows, marks document processed
- `query-matter` — embeds query, calls `match_chunks` RPC, builds grounded prompt, calls `google/gemini-2.5-flash`, returns answer + sources, writes chat_history + audit_log

### Frontend (TanStack Start file-based routes)

- `/` landing — hero, security bullets, login/signup CTA
- `/auth` — email/password login + signup tabs (auto-confirm enabled for dev)
- `/matters` — list + "New matter" dialog
- `/matters/$id` — two-column workspace
  - Left: matter info, drag-drop upload, document list with status + delete
  - Right: chat thread with collapsible source citations, query input, "thinking" state

Components: `DocumentUpload`, `ChatMessage`, `SourceCitation`, `NewMatterDialog`, `ProtectedRoute` wrapper that redirects unauthenticated users to `/auth`.

### Design direction

Editorial / legal-professional aesthetic: warm off-white background, deep navy primary, muted gold accent, serif display headings (Fraunces) + clean sans body (Inter). Tokens defined in `src/styles.css` as oklch. Restrained motion.

### Out of scope for this build

OCR for scanned PDFs, multi-user roles beyond owner, email invites, mobile app, advanced analytics — all deferrable per your spec.

### Build order

1. Enable Lovable Cloud + AI Gateway, create migration (tables, RLS, vector index, RPC, storage bucket + policies)
2. Design tokens in `src/styles.css`
3. Auth route + supabase client helpers + protected wrapper
4. Matters list + create flow
5. Matter workspace UI shell
6. `process-document` edge function + upload wiring
7. `query-matter` edge function + chat UI wiring
8. Audit log writes on upload/query/delete
9. Sitemap + robots, polish, replace placeholder index

I'll build straight through. You'll see the app come up in the preview as routes ship.
