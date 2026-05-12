import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const LOVABLE_AI_BASE = "https://ai.gateway.lovable.dev/v1";

async function embed(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("Missing LOVABLE_API_KEY");
  const res = await fetch(`${LOVABLE_AI_BASE}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": apiKey,
    },
    body: JSON.stringify({
      model: "google/text-embedding-004",
      input: texts,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Embedding API ${res.status}: ${t}`);
  }
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

function chunkText(
  text: string,
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
  // Ignore unused param
  void text;
  return chunks;
}

export const processDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { documentId: string }) =>
    z.object({ documentId: z.string().uuid() }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Authorize: fetch document via user-scoped client (RLS)
    const { data: doc, error: docErr } = await supabase
      .from("documents")
      .select("id, matter_id, storage_path, filename")
      .eq("id", data.documentId)
      .single();
    if (docErr || !doc) throw new Error("Document not found or access denied");

    try {
      // Download file via admin (storage RLS uses path prefix; admin is fine here, we already authorized)
      const { data: file, error: dlErr } = await supabaseAdmin.storage
        .from("case-documents")
        .download(doc.storage_path);
      if (dlErr || !file) throw new Error(`Download failed: ${dlErr?.message}`);

      const buf = new Uint8Array(await file.arrayBuffer());
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(buf);
      const pageCount = pdf.numPages;
      const pages: { page: number; text: string }[] = [];
      for (let p = 1; p <= pageCount; p++) {
        const { text } = await extractText(pdf, { mergePages: false, pageNumbers: [p] });
        pages.push({ page: p, text: Array.isArray(text) ? text.join(" ") : String(text) });
      }

      const chunks = chunkText("", pages);
      if (chunks.length === 0) throw new Error("No text could be extracted from this PDF.");

      // Embed in batches of 50
      const batchSize = 50;
      const all: { text: string; index: number; page: number; embedding: number[] }[] = [];
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const embeddings = await embed(batch.map((c) => c.text));
        batch.forEach((c, k) => all.push({ ...c, embedding: embeddings[k] }));
      }

      const rows = all.map((c) => ({
        document_id: doc.id,
        matter_id: doc.matter_id,
        chunk_text: c.text,
        chunk_index: c.index,
        page_number: c.page,
        embedding: c.embedding as unknown as string,
      }));

      // Insert chunks via admin to bypass auth header overhead in batch
      const { error: insErr } = await supabaseAdmin.from("chunks").insert(rows);
      if (insErr) throw new Error(`Insert chunks failed: ${insErr.message}`);

      await supabaseAdmin
        .from("documents")
        .update({ processed: true, page_count: pageCount, chunk_count: rows.length, processing_error: null })
        .eq("id", doc.id);

      await supabaseAdmin.from("audit_logs").insert({
        user_id: userId,
        matter_id: doc.matter_id,
        action: "process_document",
        details: { document_id: doc.id, pages: pageCount, chunks: rows.length },
      });

      return { ok: true, pages: pageCount, chunks: rows.length };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await supabaseAdmin
        .from("documents")
        .update({ processed: false, processing_error: msg })
        .eq("id", doc.id);
      throw new Error(msg);
    }
  });

export const queryMatter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { matterId: string; query: string }) =>
    z.object({ matterId: z.string().uuid(), query: z.string().min(1).max(2000) }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Authorize matter
    const { data: matter, error: mErr } = await supabase
      .from("matters")
      .select("id")
      .eq("id", data.matterId)
      .single();
    if (mErr || !matter) throw new Error("Matter not found");

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("Missing LOVABLE_API_KEY");

    const [queryEmbedding] = await embed([data.query]);

    const { data: matches, error: matchErr } = await supabase.rpc("match_chunks", {
      query_embedding: queryEmbedding as unknown as string,
      match_matter_id: data.matterId,
      match_count: 5,
    });
    if (matchErr) throw new Error(matchErr.message);

    const chunks = (matches ?? []) as Array<{
      id: string;
      document_id: string;
      chunk_text: string;
      chunk_index: number;
      page_number: number | null;
      similarity: number;
    }>;

    // Resolve document filenames
    const docIds = Array.from(new Set(chunks.map((c) => c.document_id)));
    const { data: docs } = await supabase
      .from("documents")
      .select("id, filename")
      .in("id", docIds.length ? docIds : ["00000000-0000-0000-0000-000000000000"]);
    const nameById = new Map((docs ?? []).map((d) => [d.id, d.filename]));

    const context_blocks = chunks
      .map((c, i) => {
        const name = nameById.get(c.document_id) ?? "Unknown";
        return `[Source ${i + 1} — ${name}, page ${c.page_number ?? "?"}]\n${c.chunk_text}`;
      })
      .join("\n\n");

    const systemPrompt =
      "You are a careful legal assistant. Answer using ONLY the provided context from the user's case documents. If the answer is not contained in the context, reply exactly: \"I don't have that information in the documents.\" Cite sources inline as [Source N].";

    const userMessage = `CONTEXT:\n${context_blocks || "(no relevant passages found)"}\n\nQUESTION: ${data.query}`;

    const model = "google/gemini-2.5-flash";
    const aiRes = await fetch(`${LOVABLE_AI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": apiKey,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
    });
    if (!aiRes.ok) {
      const t = await aiRes.text();
      if (aiRes.status === 429) throw new Error("Rate limit reached. Please wait and try again.");
      if (aiRes.status === 402) throw new Error("AI credits exhausted. Add credits in workspace settings.");
      throw new Error(`AI ${aiRes.status}: ${t}`);
    }
    const aiJson = (await aiRes.json()) as {
      choices: { message: { content: string } }[];
      usage?: { total_tokens?: number };
    };
    const answer = aiJson.choices?.[0]?.message?.content ?? "";
    const tokensUsed = aiJson.usage?.total_tokens ?? null;

    const sources = chunks.map((c, i) => ({
      n: i + 1,
      document_id: c.document_id,
      document_name: nameById.get(c.document_id) ?? "Unknown",
      page_number: c.page_number,
      similarity: Number(c.similarity.toFixed(3)),
    }));

    // Save chat + audit
    await supabaseAdmin.from("chat_history").insert({
      matter_id: data.matterId,
      user_id: userId,
      query: data.query,
      response: answer,
      source_documents: sources,
      model_used: model,
      tokens_used: tokensUsed,
    });
    await supabaseAdmin.from("audit_logs").insert({
      user_id: userId,
      matter_id: data.matterId,
      action: "query",
      details: { tokens: tokensUsed },
    });

    return { answer, sources, model, tokensUsed };
  });
