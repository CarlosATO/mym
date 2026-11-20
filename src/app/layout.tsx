import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PetGroup | Sistema Unificado",
  description: "Plataforma de gestión corporativa PetGroup",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider
          attribute="data-theme"
          defaultTheme="light"
          themes={["light", "dark"]}
          storageKey="theme"
          enableSystem={false}
          disableTransitionOnChange
        >
          {children}
          <Toaster
            richColors
            closeButton
            position="bottom-center"
            duration={3500}
            offset={20}
            toastOptions={{
              className:
                "rounded-xl border shadow-lg text-xs font-medium px-4 py-3",
            }}
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
