import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, AlertCircle, Loader2, Trash2, Upload, Send, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { processDocument, queryMatter } from "@/lib/rag.functions";
import { AppHeader } from "@/components/AppHeader";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

export const Route = createFileRoute("/matters/$id")({
  head: () => ({ meta: [{ title: "Workspace — SecureCase AI" }] }),
  component: () => (
    <ProtectedRoute>
      <MatterWorkspace />
    </ProtectedRoute>
  ),
});

type Matter = {
  id: string;
  case_number: string;
  client_name: string;
  case_type: string | null;
  description: string | null;
};

type DocRow = {
  id: string;
  filename: string;
  document_type: string | null;
  upload_date: string;
  processed: boolean;
  processing_error: string | null;
  page_count: number | null;
  chunk_count: number | null;
  storage_path: string;
};

type ChatRow = {
  id: string;
  query: string;
  response: string;
  source_documents: Array<{
    n: number;
    document_name: string;
    page_number: number | null;
    similarity: number;
  }> | null;
  tokens_used: number | null;
  created_at: string;
};

function MatterWorkspace() {
  const { id } = Route.useParams();
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: matter } = useQuery({
    queryKey: ["matter", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("matters").select("*").eq("id", id).single();
      if (error) throw error;
      return data as Matter;
    },
  });

  const { data: docs } = useQuery({
    queryKey: ["documents", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("documents")
        .select("*")
        .eq("matter_id", id)
        .order("upload_date", { ascending: false });
      if (error) throw error;
      return data as DocRow[];
    },
    refetchInterval: (q) => {
      const rows = (q.state.data ?? []) as DocRow[];
      return rows.some((d) => !d.processed && !d.processing_error) ? 3000 : false;
    },
  });

  const { data: chat } = useQuery({
    queryKey: ["chat", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("chat_history")
        .select("*")
        .eq("matter_id", id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data as ChatRow[];
    },
  });

  const processFn = useServerFn(processDocument);
  const queryFn = useServerFn(queryMatter);

  const uploadAndProcess = useMutation({
    mutationFn: async (file: File) => {
      if (!user) throw new Error("Not signed in");
      if (file.type !== "application/pdf") throw new Error("Only PDF files are supported.");
      if (file.size > 50 * 1024 * 1024) throw new Error("File exceeds 50 MB limit.");
      const safe = file.name.replace(/[^\w.\-]+/g, "_");
      const path = `${user.id}/${id}/${Date.now()}-${safe}`;
      const { error: upErr } = await supabase.storage
        .from("case-documents")
        .upload(path, file, { contentType: "application/pdf" });
      if (upErr) throw upErr;
      const { data: doc, error: insErr } = await supabase
        .from("documents")
        .insert({
          matter_id: id,
          filename: file.name,
          storage_path: path,
          file_size: file.size,
          uploaded_by: user.id,
        })
        .select()
        .single();
      if (insErr) throw insErr;
      await supabase.from("audit_logs").insert({
        user_id: user.id,
        matter_id: id,
        action: "upload_document",
        details: { document_id: doc.id, filename: file.name },
      });
      qc.invalidateQueries({ queryKey: ["documents", id] });
      // fire-and-await processing (but don't await long; show optimistic)
      await processFn({ data: { documentId: doc.id } });
      qc.invalidateQueries({ queryKey: ["documents", id] });
    },
    onError: (e: Error) => toast.error(e.message),
    onSuccess: () => toast.success("Document processed"),
  });

  const deleteDoc = useMutation({
    mutationFn: async (doc: DocRow) => {
      await supabase.storage.from("case-documents").remove([doc.storage_path]);
      const { error } = await supabase.from("documents").delete().eq("id", doc.id);
      if (error) throw error;
      await supabase.from("audit_logs").insert({
        user_id: user!.id,
        matter_id: id,
        action: "delete_document",
        details: { document_id: doc.id },
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["documents", id] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const ask = useMutation({
    mutationFn: async (query: string) => {
      return await queryFn({ data: { matterId: id, query } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["chat", id] }),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader />
      <main className="mx-auto flex w-full max-w-7xl flex-1 gap-6 px-6 py-8">
        {/* Sidebar */}
        <aside className="w-80 shrink-0 space-y-6">
          <div>
            <p className="text-xs uppercase tracking-widest text-muted-foreground">
              {matter?.case_type || "Matter"}
            </p>
            <h1 className="mt-1 font-display text-2xl text-primary">{matter?.client_name}</h1>
            <p className="text-sm text-muted-foreground">#{matter?.case_number}</p>
          </div>

          <DropZone
            disabled={uploadAndProcess.isPending}
            onFile={(f) => uploadAndProcess.mutate(f)}
          />

          <div>
            <h2 className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">
              Documents ({docs?.length ?? 0})
            </h2>
            <ul className="space-y-2">
              {docs?.map((d) => (
                <li
                  key={d.id}
                  className="rounded-md border border-border bg-card p-3 text-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{d.filename}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {d.processed ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700">
                            <CheckCircle2 className="h-3 w-3" /> {d.page_count}p · {d.chunk_count} chunks
                          </span>
                        ) : d.processing_error ? (
                          <span className="inline-flex items-center gap-1 text-destructive">
                            <AlertCircle className="h-3 w-3" /> error
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" /> processing
                          </span>
                        )}
                      </p>
                      {d.processing_error && (
                        <p className="mt-1 text-xs text-destructive">{d.processing_error}</p>
                      )}
                    </div>
                    <button
                      onClick={() => deleteDoc.mutate(d)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label="Delete document"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        {/* Chat */}
        <section className="flex flex-1 flex-col rounded-lg border border-border bg-card">
          <div className="flex-1 space-y-6 overflow-y-auto p-6">
            {!chat?.length && !ask.isPending && (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <h2 className="font-display text-2xl text-primary">Ask about this matter</h2>
                <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                  Try: "Summarize the medical history" or "What does the deposition say about
                  liability?" Answers cite the source document and page.
                </p>
              </div>
            )}
            {chat?.map((c) => (
              <div key={c.id} className="space-y-3">
                <div className="ml-auto max-w-[80%] rounded-lg bg-primary px-4 py-2 text-primary-foreground">
                  {c.query}
                </div>
                <div className="max-w-[90%] rounded-lg bg-secondary px-4 py-3">
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">{c.response}</p>
                  {c.source_documents && c.source_documents.length > 0 && (
                    <Collapsible className="mt-3">
                      <CollapsibleTrigger className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                        <ChevronDown className="h-3 w-3" />
                        {c.source_documents.length} source{c.source_documents.length === 1 ? "" : "s"}
                      </CollapsibleTrigger>
                      <CollapsibleContent className="mt-2 space-y-1">
                        {c.source_documents.map((s) => (
                          <div
                            key={s.n}
                            className="rounded border border-border bg-card px-2 py-1 text-xs"
                          >
                            <span className="font-semibold">[{s.n}]</span> {s.document_name}
                            {s.page_number ? `, p. ${s.page_number}` : ""} ·{" "}
                            <span className="text-muted-foreground">
                              {(s.similarity * 100).toFixed(0)}% match
                            </span>
                          </div>
                        ))}
                      </CollapsibleContent>
                    </Collapsible>
                  )}
                  {c.tokens_used != null && (
                    <p className="mt-2 text-[10px] uppercase tracking-widest text-muted-foreground">
                      {c.tokens_used} tokens
                    </p>
                  )}
                </div>
              </div>
            ))}
            {ask.isPending && (
              <div className="max-w-[90%] rounded-lg bg-secondary px-4 py-3 text-sm text-muted-foreground">
                <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                Thinking…
              </div>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const q = String(fd.get("q") ?? "").trim();
              if (!q) return;
              (e.currentTarget as HTMLFormElement).reset();
              ask.mutate(q);
            }}
            className="border-t border-border p-4"
          >
            <div className="flex gap-2">
              <Input
                name="q"
                placeholder="Ask a question about this case…"
                disabled={ask.isPending || !docs?.some((d) => d.processed)}
              />
              <Button type="submit" disabled={ask.isPending}>
                <Send className="h-4 w-4" />
              </Button>
            </div>
            {!docs?.some((d) => d.processed) && (
              <p className="mt-2 text-xs text-muted-foreground">
                Upload and process at least one PDF to start asking questions.
              </p>
            )}
          </form>
        </section>
      </main>
    </div>
  );
}

function DropZone({ onFile, disabled }: { onFile: (f: File) => void; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      className={`rounded-lg border-2 border-dashed p-6 text-center transition ${
        over ? "border-accent bg-accent/10" : "border-border bg-card"
      } ${disabled ? "opacity-60" : ""}`}
    >
      <Upload className="mx-auto h-6 w-6 text-muted-foreground" />
      <p className="mt-2 text-sm font-medium">Drop a PDF here</p>
      <p className="text-xs text-muted-foreground">or</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {disabled ? "Processing…" : "Choose file"}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
