import "./globals.css";
import type { Metadata } from "next";
import ThemeProvider from "@/components/providers/theme-provider";
import { StoreProvider } from "@/components/providers/store-provider";
import { Toaster } from "@/ui/common/sonner";
import Header from "@/components/header/header";
import { SiteChrome } from "@/components/layout/site-chrome";
import Footer from "@/components/footer/index";
import SWRProvider from "@/components/providers/swr-provider";
import { Analytics as VercelAnalytics } from "@vercel/analytics/react";
import { Analytics as OtherAnalytics } from "@/components/analytics";

export const metadata: Metadata = {
  title: "AskWalle AI Hub - Discover the Best AI Tools",
  description:
    "Explore AI tools for writing, image generation, coding, productivity, marketing, business, and more.",
  keywords: [
    "AI tools",
    "AI directory",
    "writing AI",
    "image generation",
    "coding AI",
    "productivity AI",
    "marketing AI",
    "business AI",
  ],
  openGraph: {
    title: "AskWalle AI Hub - Discover the Best AI Tools",
    description:
      "Explore AI tools for writing, image generation, coding, productivity, marketing, business, and more.",
    type: "website",
    siteName: "AskWalle AI Hub",
  },
  twitter: {
    card: "summary_large_image",
    title: "AskWalle AI Hub - Discover the Best AI Tools",
    description:
      "Explore AI tools for writing, image generation, coding, productivity, marketing, business, and more.",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        suppressHydrationWarning
        className="min-h-screen flex flex-col bg-background"
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <StoreProvider>
            {/* 后台与登录页不套前台外壳 —— 后台有自己的常驻导航 */}
            <SiteChrome header={<Header />} footer={<Footer />}>
              {children}
            </SiteChrome>
            <Toaster />
          </StoreProvider>
        </ThemeProvider>
        <VercelAnalytics />
        <OtherAnalytics googleAnalyticsId="G-9MNGY82H1J" />
      </body>
    </html>
  );
}
