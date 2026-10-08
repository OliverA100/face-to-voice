import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "@/components/ui/loader/orbPoster.css";
import { TooltipLayer } from "@/components/ui/TooltipLayer";

// Inter for everything (400 for titles and text, 500 for labels), JetBrains Mono for the voice prompt and debug readouts.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], weight: ["400", "500"] });
const mono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"], weight: ["400"] });

export const metadata: Metadata = {
  // Pages set just their own name ("Icon lab"); the template adds the suffix.
  title: { default: "Face to Voice — Build a face, hear its voice", template: "%s · Face to Voice" },
  description: "Shape a 3D head with sliders, get a matching ElevenLabs voice, and hear it speak with lip sync.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        {children}
        <TooltipLayer />
      </body>
    </html>
  );
}
