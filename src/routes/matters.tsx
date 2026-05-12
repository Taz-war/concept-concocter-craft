import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Folder, FileText } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { AppHeader } from "@/components/AppHeader";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/matters")({
  head: () => ({ meta: [{ title: "Matters — SecureCase AI" }] }),
  component: () => (
    <ProtectedRoute>
      <MattersPage />
    </ProtectedRoute>
  ),
});

type Matter = {
  id: string;
  case_number: string;
  client_name: string;
  case_type: string | null;
  description: string | null;
  created_at: string;
};

function MattersPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: matters, isLoading } = useQuery({
    queryKey: ["matters", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("matters")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Matter[];
    },
  });

  const createMatter = useMutation({
    mutationFn: async (m: Omit<Matter, "id" | "created_at">) => {
      const { data, error } = await supabase
        .from("matters")
        .insert({ ...m, user_id: user!.id })
        .select()
        .single();
      if (error) throw error;
      await supabase.from("audit_logs").insert({
        user_id: user!.id,
        matter_id: data.id,
        action: "create_matter",
        details: { case_number: m.case_number },
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["matters"] });
      setOpen(false);
      toast.success("Matter created");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-6 py-12">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="font-display text-4xl text-primary">Your matters</h1>
            <p className="mt-2 text-muted-foreground">
              Each matter is an isolated workspace with its own documents and chat.
            </p>
          </div>

          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" /> New matter
              </Button>
            </DialogTrigger>
            <DialogContent>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  createMatter.mutate({
                    case_number: String(fd.get("case_number")),
                    client_name: String(fd.get("client_name")),
                    case_type: String(fd.get("case_type") || "") || null,
                    description: String(fd.get("description") || "") || null,
                  });
                }}
                className="space-y-4"
              >
                <DialogHeader>
                  <DialogTitle>New matter</DialogTitle>
                  <DialogDescription>
                    Create a new case workspace. Only you will be able to see it.
                  </DialogDescription>
                </DialogHeader>
                <Field name="case_number" label="Case number" required />
                <Field name="client_name" label="Client name" required />
                <Field name="case_type" label="Case type" placeholder="e.g. Personal Injury" />
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea id="description" name="description" rows={3} />
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={createMatter.isPending}>
                    {createMatter.isPending ? "Creating…" : "Create matter"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <div className="mt-10">
          {isLoading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : !matters?.length ? (
            <div className="rounded-lg border border-dashed border-border bg-card p-12 text-center">
              <Folder className="mx-auto h-10 w-10 text-muted-foreground" />
              <p className="mt-4 font-display text-xl text-primary">No matters yet</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Open your first case to start uploading documents.
              </p>
            </div>
          ) : (
            <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {matters.map((m) => (
                <li key={m.id}>
                  <Link
                    to="/matters/$id"
                    params={{ id: m.id }}
                    className="block h-full rounded-lg border border-border bg-card p-6 transition hover:border-accent hover:shadow-sm"
                  >
                    <div className="flex items-start justify-between">
                      <span className="text-xs uppercase tracking-widest text-muted-foreground">
                        {m.case_type || "Matter"}
                      </span>
                      <FileText className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <h3 className="mt-3 font-display text-2xl text-primary">{m.client_name}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">#{m.case_number}</p>
                    {m.description && (
                      <p className="mt-3 line-clamp-2 text-sm text-foreground/70">{m.description}</p>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}

function Field(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const { label, ...rest } = props;
  return (
    <div className="space-y-2">
      <Label htmlFor={rest.name}>{label}</Label>
      <Input id={rest.name} {...rest} />
    </div>
  );
}
