import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/providers/theme-provider";
import QueryProvider from "@/components/providers/query-provider";

export const metadata: Metadata = {
  title: "DevPilot",
  description: "Analyze public GitHub repositories and chat with their code.",
};

const backendOrigin = (
  process.env.NEXT_PUBLIC_API_BASE_URL || "https://devpilot-backend-iso1.onrender.com"
).replace(/\/$/, "");

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href={backendOrigin} crossOrigin="anonymous" />
        <link rel="dns-prefetch" href={backendOrigin} />
      </head>
      <body className="min-h-full flex flex-col">
        <QueryProvider>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
