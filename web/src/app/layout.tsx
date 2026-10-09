import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "@/components/ui/loader/orbPoster.css";
import { TooltipLayer } from "@/components/ui/TooltipLayer";

// Inter for everything (400 for titles and text, 500 for labels), JetBrains Mono for the voice prompt and debug readouts.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], weight: ["400", "500"] });
const mono = JetBrains_Mono({ variable: "--font-jetbrains-mono", subsets: ["latin"], weight: ["400"] });

const TITLE = "Face to Voice — Build a face, hear its voice";
const DESCRIPTION = "Shape a 3D head with sliders, get a matching ElevenLabs voice, and hear it speak with lip sync.";

export const metadata: Metadata = {
  // The address link previews resolve against; the preview image is app/opengraph-image.jpg (and twitter-image.jpg).
  metadataBase: new URL("https://facetovoice.com"),
  // Pages set just their own name; the template adds the suffix.
  title: { default: TITLE, template: "%s · Face to Voice" },
  description: DESCRIPTION,
  openGraph: { type: "website", url: "/", siteName: "Face to Voice", title: TITLE, description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

// cover: the page reaches under the notch and Safari's toolbar (the app keeps its edges clear with env(safe-area-inset-*)).
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

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
