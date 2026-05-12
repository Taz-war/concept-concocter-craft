import { createFileRoute, Link } from "@tanstack/react-router";
import { Shield, Lock, FileSearch, Quote } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen">
      <AppHeader />
      <main>
        <section className="mx-auto max-w-5xl px-6 pb-24 pt-24">
          <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs uppercase tracking-widest text-muted-foreground">
            <Shield className="h-3 w-3 text-accent" /> Private by design
          </p>
          <h1 className="font-display text-5xl leading-[1.05] text-primary md:text-7xl">
            A quiet workspace for the
            <span className="italic text-accent"> facts </span>
            of your case.
          </h1>
          <p className="mt-8 max-w-2xl text-lg text-muted-foreground">
            SecureCase AI ingests your matter's documents, isolates them per case, and answers
            questions strictly from what's on the page — with citations down to the page number.
            No model training. No data sharing.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link to="/auth">Open a workspace</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/matters">Go to my matters</Link>
            </Button>
          </div>
        </section>

        <section className="border-y border-border bg-card">
          <div className="mx-auto grid max-w-5xl gap-px bg-border px-0 md:grid-cols-3">
            <Feature
              icon={<Lock className="h-5 w-5 text-accent" />}
              title="Matter isolation"
              body="Row-level security guarantees a user can only ever retrieve documents from their own matter."
            />
            <Feature
              icon={<FileSearch className="h-5 w-5 text-accent" />}
              title="Grounded answers"
              body="Retrieval-augmented generation: every answer cites the document and page it came from."
            />
            <Feature
              icon={<Quote className="h-5 w-5 text-accent" />}
              title="No fabrication"
              body="If the answer isn't in your documents, the assistant says so. Plain."
            />
          </div>
        </section>

        <section className="mx-auto max-w-3xl px-6 py-24 text-center">
          <h2 className="font-display text-3xl text-primary md:text-4xl">
            Built for personal injury & workers' comp practice.
          </h2>
          <p className="mt-4 text-muted-foreground">
            Drop in medical records, depositions, bills. Ask plain-English questions. Get back
            cited passages — fast.
          </p>
        </section>
      </main>
      <footer className="border-t border-border bg-card">
        <div className="mx-auto max-w-5xl px-6 py-8 text-sm text-muted-foreground">
          © {new Date().getFullYear()} SecureCase AI · Confidential by default
        </div>
      </footer>
    </div>
  );
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="bg-card p-8">
      <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-md bg-secondary">
        {icon}
      </div>
      <h3 className="font-display text-xl text-primary">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
