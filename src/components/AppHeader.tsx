import { Link, useNavigate } from "@tanstack/react-router";
import { Scale, LogOut } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";

export function AppHeader() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <header className="border-b border-border bg-card/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link to="/" className="flex items-center gap-2">
          <Scale className="h-5 w-5 text-primary" />
          <span className="font-display text-xl font-semibold text-primary">
            SecureCase <span className="text-accent">AI</span>
          </span>
        </Link>
        <nav className="flex items-center gap-3">
          {user ? (
            <>
              <Link
                to="/matters"
                className="text-sm font-medium text-foreground/80 hover:text-foreground"
                activeProps={{ className: "text-sm font-semibold text-primary" }}
              >
                Matters
              </Link>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  await signOut();
                  navigate({ to: "/" });
                }}
              >
                <LogOut className="mr-2 h-4 w-4" /> Sign out
              </Button>
            </>
          ) : (
            <Button asChild size="sm">
              <Link to="/auth">Sign in</Link>
            </Button>
          )}
        </nav>
      </div>
    </header>
  );
}
