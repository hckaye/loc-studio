import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "loc-studio",
  description: "ゲーム向けローカライゼーションテキスト管理",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja" data-theme="light">
      <body>{children}</body>
    </html>
  );
}
