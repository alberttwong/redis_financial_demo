import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Redis Financial Demo",
  description: "Redis Cloud 8.4 SQL-batched financial query pattern demo"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
