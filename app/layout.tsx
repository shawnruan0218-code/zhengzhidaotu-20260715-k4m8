import type { Metadata } from "next";
import "./globals.css";

const title = "政治图谱复习室";
const description = "可跳页、可缩放、支持 Q 键高亮的考研政治思维导图复习网站。";

export const metadata: Metadata = {
  metadataBase: new URL("https://shawnruan0218-code.github.io/zhengzhidaotu-20260715-k4m8/"),
  title,
  description,
  openGraph: {
    title,
    description,
    type: "website",
    url: "https://shawnruan0218-code.github.io/zhengzhidaotu-20260715-k4m8/",
  },
  twitter: {
    card: "summary",
    title,
    description,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
