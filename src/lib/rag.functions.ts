"use server";

import { z } from "zod";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

// Helper to check auth inside server action
async function getAuth() {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Ignore error from setting cookies inside Server Action
          }
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Unauthorized");
  return { supabase, userId: user.id };
}

// ---------------------------------------------------------------------------
// Text chunking (no embeddings needed)
// ---------------------------------------------------------------------------
function chunkText(
  pages: { page: number; text: string }[],
  size = 1000,
  overlap = 200
): { text: string; index: number; page: number }[] {
  const chunks: { text: string; index: number; page: number }[] = [];
  let idx = 0;
  for (const p of pages) {
    const t = p.text.replace(/\s+/g, " ").trim();
    if (!t) continue;
    let i = 0;
    while (i < t.length) {
      const slice = t.slice(i, i + size);
      chunks.push({ text: slice, index: idx++, page: p.page });
      if (i + size >= t.length) break;
      i += size - overlap;
    }
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Keyword-based chunk retrieval (replaces vector similarity search)
// Extracts keywords from the query and scores each chunk by keyword hits.
// ---------------------------------------------------------------------------
function searchChunksByKeywords(
  allChunks: {
    id: string;
    document_id: string;
    chunk_text: string;
    chunk_index: number;
    page_number: number | null;
  }[],
  query: string,
  topK = 8
) {
  // Extract meaningful keywords (3+ chars, lowercased, deduplicated)
  const stopWords = new Set([
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
    "her", "was", "one", "our", "out", "has", "have", "been", "some",
    "them", "than", "its", "over", "such", "that", "this", "with", "will",
    "each", "from", "they", "what", "which", "their", "said", "about",
    "would", "make", "like", "into", "could", "time", "very", "when",
    "come", "made", "find", "more", "also", "does", "where", "how",
  ]);

  const keywords = Array.from(
    new Set(
      query
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !stopWords.has(w))
    )
  );

  if (keywords.length === 0) {
    // Fallback: return first N chunks in document order
    return allChunks.slice(0, topK).map((c) => ({ ...c, similarity: 0.5 }));
  }

  // Score each chunk by how many keywords appear in it
  const scored = allChunks.map((chunk) => {
    const lower = chunk.chunk_text.toLowerCase();
    let hits = 0;
    let totalOccurrences = 0;
    for (const kw of keywords) {
      const count = lower.split(kw).length - 1;
      if (count > 0) {
        hits++;
        totalOccurrences += count;
      }
    }
    // similarity = ratio of keywords found + small boost for frequency
    const similarity =
      keywords.length > 0
        ? hits / keywords.length + Math.min(totalOccurrences * 0.01, 0.2)
        : 0;
    return { ...chunk, similarity: Math.min(similarity, 1) };
  });

  // Sort descending by score, return top K
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.filter((s) => s.similarity > 0).slice(0, topK);
}

// ---------------------------------------------------------------------------
// processDocument — extract PDF text, chunk it, store chunks (no embeddings)
// ---------------------------------------------------------------------------
export async function processDocument(input: { documentId: string }) {
  z.object({ documentId: z.string().uuid() }).parse(input);
  const { supabase, userId } = await getAuth();

  const { data: doc, error: docErr } = await supabase
    .from("documents")
    .select("id, matter_id, storage_path, filename")
    .eq("id", input.documentId)
    .single();
  if (docErr || !doc) throw new Error("Document not found or access denied");

  try {
    const { data: file, error: dlErr } = await supabase.storage
      .from("case-documents")
      .download(doc.storage_path);
    if (dlErr || !file) throw new Error(`Download failed: ${dlErr?.message}`);

    const buf = new Uint8Array(await file.arrayBuffer());
    // @ts-ignore — unpdf has no type declarations
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(buf);
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pageCount = totalPages;
    const pages: { page: number; text: string }[] = text.map(
      (t: string, i: number) => ({
        page: i + 1,
        text: String(t ?? ""),
      })
    );

    const chunks = chunkText(pages);
    if (chunks.length === 0)
      throw new Error("No text could be extracted from this PDF.");

    // Store chunks WITHOUT embeddings (embedding column is nullable)
    const rows = chunks.map((c) => ({
      document_id: doc.id,
      matter_id: doc.matter_id,
      chunk_text: c.text,
      chunk_index: c.index,
      page_number: c.page,
    }));

    const { error: insErr } = await supabase.from("chunks").insert(rows);
    if (insErr) throw new Error(`Insert chunks failed: ${insErr.message}`);

    await supabase
      .from("documents")
      .update({
        processed: true,
        page_count: pageCount,
        chunk_count: rows.length,
        processing_error: null,
      })
      .eq("id", doc.id);

    await supabase.from("audit_logs").insert({
      user_id: userId,
      matter_id: doc.matter_id,
      action: "process_document",
      details: {
        document_id: doc.id,
        pages: pageCount,
        chunks: rows.length,
      },
    });

    return { ok: true, pages: pageCount, chunks: rows.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabase
      .from("documents")
      .update({ processed: false, processing_error: msg })
      .eq("id", doc.id);
    throw new Error(msg);
  }
}

// ---------------------------------------------------------------------------
// queryMatter — keyword search chunks, then ask Gemini for an answer
// ---------------------------------------------------------------------------
export async function queryMatter(input: {
  matterId: string;
  query: string;
}) {
  z.object({
    matterId: z.string().uuid(),
    query: z.string().min(1).max(2000),
  }).parse(input);
  const { supabase, userId } = await getAuth();

  // Verify matter access
  const { data: matter, error: mErr } = await supabase
    .from("matters")
    .select("id")
    .eq("id", input.matterId)
    .single();
  if (mErr || !matter) throw new Error("Matter not found");

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    throw new Error(
      "Missing GEMINI_API_KEY environment variable. Please add it to your .env file."
    );

  // Fetch all processed chunks for this matter
  const { data: allChunks, error: chunkErr } = await supabase
    .from("chunks")
    .select("id, document_id, chunk_text, chunk_index, page_number")
    .eq("matter_id", input.matterId)
    .order("chunk_index", { ascending: true });
  if (chunkErr) throw new Error(chunkErr.message);

  // Find the most relevant chunks via keyword matching
  const matchedChunks = searchChunksByKeywords(allChunks ?? [], input.query, 8);

  // Look up document filenames
  const docIds = Array.from(
    new Set(matchedChunks.map((c) => c.document_id))
  );
  const { data: docs } = await supabase
    .from("documents")
    .select("id, filename")
    .in(
      "id",
      docIds.length
        ? docIds
        : ["00000000-0000-0000-0000-000000000000"]
    );
  const nameById = new Map(
    (docs ?? []).map((d) => [d.id, d.filename])
  );

  // Build context string
  const context_blocks = matchedChunks
    .map((c, i) => {
      const name = nameById.get(c.document_id) ?? "Unknown";
      return `[Source ${i + 1} — ${name}, page ${c.page_number ?? "?"}]\n${c.chunk_text}`;
    })
    .join("\n\n");

  const systemPrompt =
    'You are a careful legal assistant. Answer using ONLY the provided context from the user\'s case documents. If the answer is not contained in the context, reply exactly: "I don\'t have that information in the documents." Cite sources inline as [Source N].';

  const userMessage = `CONTEXT:\n${context_blocks || "(no relevant passages found)"}\n\nQUESTION: ${input.query}`;

  // Call Gemini generateContent (available on the free tier)
  const model = "gemini-2.5-flash";
  const aiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
      }),
    }
  );
  if (!aiRes.ok) {
    const t = await aiRes.text();
    if (aiRes.status === 429)
      throw new Error("Rate limit reached. Please wait and try again.");
    throw new Error(`AI ${aiRes.status}: ${t}`);
  }
  const aiJson = await aiRes.json();
  const answer =
    aiJson.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const tokensUsed =
    aiJson.usageMetadata?.totalTokenCount ?? null;

  const sources = matchedChunks.map((c, i) => ({
    n: i + 1,
    document_id: c.document_id,
    document_name: nameById.get(c.document_id) ?? "Unknown",
    page_number: c.page_number,
    similarity: Number(c.similarity.toFixed(3)),
  }));

  await supabase.from("chat_history").insert({
    matter_id: input.matterId,
    user_id: userId,
    query: input.query,
    response: answer,
    source_documents: sources,
    model_used: model,
    tokens_used: tokensUsed,
  });
  await supabase.from("audit_logs").insert({
    user_id: userId,
    matter_id: input.matterId,
    action: "query",
    details: { tokens: tokensUsed },
  });

  return { answer, sources, model, tokensUsed };
}
