import { AuthProvider } from "@/lib/auth";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";
import { Providers } from "./providers";

export const metadata = {
  title: "SecureCase AI — Private RAG for legal matters",
  description: "Upload case documents, ask questions, get answers grounded in citations. Private by design.",
  openGraph: {
    title: "SecureCase AI",
    description: "Private, matter-isolated RAG for legal teams.",
    type: "website",
  },
  twitter: {
    card: "summary",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <AuthProvider>
            {children}
            <Toaster />
          </AuthProvider>
        </Providers>
      </body>
    </html>
  );
}
